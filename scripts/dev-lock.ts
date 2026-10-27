/**
 * Next dev lock (`service/.next/dev/lock`) inspection.
 *
 * Next 16 holds an exclusive flock on `<distDir>/lock` and writes
 * `{pid,port,hostname,appUrl,startedAt}` into it (`next/dist/build/lockfile.js`). On POSIX
 * the file outlives the process, so a crashed dev server leaves a lock naming a dead pid.
 * The three interesting cases are not interchangeable:
 *
 * - pid gone        -> the flock went with the process; the file is garbage, deleting it
 *                      is safe and unblocks the next `bun run dev`;
 * - pid alive + next -> a real dev server owns the port. A second `next dev` binds the port
 *                      first and only then fails to take the lock, so refuse before spawn;
 * - pid alive + other -> the pid was reused by an unrelated process; warn, never delete.
 *
 * Classification is a pure function over the file text plus an injected probe, so the tests
 * drive every branch without starting Next.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type ProcessEntry = { pid: number; ppid: number; pgrp: number; session: number };

/**
 * Command lines that are a Next dev server. Deliberately narrow: `/next/i` also matches
 * `tail -f app.next.log` or `vim .next/dev/lock`, and the lock's pid is trusted on the
 * strength of this match — a false positive blocks startup and gets an unrelated process
 * killed. The three forms are the `next dev` CLI (`.bin/next`, `next/dist/bin/next`) and the
 * server process whose title Next rewrites to `next-server (v16.4.3)`.
 */
export const NEXT_PROCESS_PATTERN = /next-server|\.bin\/next\b|next\/dist\/bin\/next/;
/** The `next dev` CLI itself — the parent of `next-server`. Not `next-server`, not a shell. */
export const NEXT_DEV_CLI_PATTERN = /next-dev|\.bin\/next\b|next\/dist\/bin\/next/;
/** Everything `bun run dev` owns: the Next dev server plus the repo's worker. */
export const REPO_PROCESS_PATTERN = /next-server|\.bin\/next\b|next\/dist\/bin\/next|src\/worker\.ts/;

export type LockState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "stale"; pid: number; port: number }
  | {
      kind: "running";
      pid: number;
      port: number;
      appUrl: string;
      startedAt: number;
      listening: boolean;
    }
  | { kind: "unknown"; pid: number; reason: string };

export type LockProbe = {
  alive(pid: number): boolean;
  cmdline(pid: number): string | null;
  listening(port: number): boolean;
  /** True when the pid provably belongs to this service dir (see `isRepoProcess`). */
  ownedByRepo(pid: number): boolean;
};

/** `realpath` when it resolves, the input otherwise. Symlinked checkouts must compare equal. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A process that belongs to this checkout's dev stack: its command line is the Next dev server
 * or the repo worker **and** its cwd is the service dir. The cwd check is what keeps a lock
 * naming another checkout's `next-server` from being trusted (and killed).
 *
 * A cwd that cannot be read (macOS without lsof, hidepid) degrades to the command line alone —
 * refusing everything there would make `dev:stop` a no-op on those platforms.
 */
export function isRepoProcess(
  pid: number,
  serviceDir: string,
  readCwd: (pid: number) => string | null = readProcessCwd,
): boolean {
  const cmdline = readProcessCmdline(pid);
  if (cmdline === null || !REPO_PROCESS_PATTERN.test(cmdline)) return false;
  const cwd = readCwd(pid);
  if (cwd === null) return true;
  return canonicalPath(stripDeletedSuffix(cwd)) === canonicalPath(serviceDir);
}

/** `<service>/.next/dev/lock` — the path Next 16 derives from `distDir` in dev. */
export function devLockPath(serviceDir: string): string {
  return join(serviceDir, ".next", "dev", "lock");
}

/**
 * True when the pid exists. A zombie counts as gone: it has already closed every fd, so it
 * cannot be holding the lock, and waiting on it only makes stop paths hang.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform === "linux" && readProcStatTail(pid)?.[0] === "Z") return false;
  return true;
}

/**
 * Full command line of a pid, or null when it cannot be read (gone, zombie, other user).
 * Linux uses /proc; everything else falls back to `ps`.
 */
export function readProcessCmdline(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const text = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text.length > 0) return text;
    } catch {
      // Fall through to ps: /proc may be unavailable (hidepid) even on Linux.
    }
  }
  try {
    const text = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Parent pid, or null when it cannot be read. */
export function readParentPid(pid: number): number | null {
  if (process.platform === "linux") {
    const ppid = Number(readProcStatTail(pid)?.[1]);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  }
  try {
    const text = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ppid = Number(text);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** Session id of a pid, or null when it cannot be read. */
export function readProcessSession(pid: number): number | null {
  if (process.platform === "linux") {
    const session = Number(readProcStatTail(pid)?.[3]);
    return Number.isInteger(session) && session > 0 ? session : null;
  }
  return listProcesses().find((entry) => entry.pid === pid)?.session ?? null;
}

/**
 * Every pid in the session. `bun run --filter` gives the real script a new process group but
 * keeps the session its parent created, so this is the only handle that still reaches
 * `next-server` after it was reparented to init. Linux only: elsewhere the field is unknown
 * and the caller falls back to walking the tree.
 */
export function readSessionMembers(session: number): number[] {
  if (!Number.isInteger(session) || session <= 0) return [];
  return listProcesses()
    .filter((entry) => entry.session === session)
    .map((entry) => entry.pid);
}

/** `pid` plus every live descendant, by parent links. */
export function readProcessTree(pid: number): number[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const childrenOf = new Map<number, number[]>();
  for (const entry of listProcesses()) {
    const siblings = childrenOf.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else childrenOf.set(entry.ppid, [entry.pid]);
  }

  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}

/** Working directory of a pid. `/proc` on Linux, `lsof` elsewhere; null when unreadable. */
export function readProcessCwd(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const text = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = text.split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/** Every live process that belongs to this checkout's dev stack. */
export function findRepoProcesses(serviceDir: string): number[] {
  return listProcesses()
    .map((entry) => entry.pid)
    .filter((pid) => pid !== process.pid && pid > 1 && isRepoProcess(pid, serviceDir));
}

function listProcesses(): ProcessEntry[] {
  if (process.platform === "linux") {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return [];
    }
    const entries: ProcessEntry[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const tail = readProcStatTail(pid);
      if (tail === null) continue;
      const ppid = Number(tail[1]);
      const pgrp = Number(tail[2]);
      const session = Number(tail[3]);
      if (!Number.isInteger(ppid) || !Number.isInteger(session)) continue;
      entries.push({ pid, ppid, pgrp, session });
    }
    return entries;
  }

  try {
    const text = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries: ProcessEntry[] = [];
    for (const line of text.split("\n")) {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      entries.push({ pid, ppid, pgrp: Number.isInteger(pgid) ? pgid : 0, session: 0 });
    }
    return entries;
  } catch {
    return [];
  }
}

function readProcStatTail(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Parsing from the last `)` keeps comm values with spaces/parens from shifting the fields.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** True when something accepts connections on the port right now. */
export function isPortListening(port: number): boolean {
  if (!Number.isInteger(port) || port <= 0) return false;
  if (process.platform === "linux") return linuxPortListening(port);
  try {
    const text = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return text.length > 0;
  } catch {
    return false;
  }
}

/** Best-effort pid listening on the port, for diagnostics only. Never used to kill. */
export function findPortListenerPid(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const text =
      process.platform === "linux"
        ? execFileSync("ss", ["-ltnpH", `sport = :${port}`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          })
        : execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const match = text.match(/pid=(\d+)/) ?? text.match(/^\s*(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function defaultProbe(serviceDir: string): LockProbe {
  return {
    alive: isProcessAlive,
    cmdline: readProcessCmdline,
    listening: isPortListening,
    ownedByRepo: (pid) => isRepoProcess(pid, serviceDir),
  };
}

/**
 * Classifies the lock file text. `null` means the file does not exist; an empty or malformed
 * body is `unreadable` — we cannot prove who owns the flock, so nothing gets deleted.
 *
 * `running` needs all three of: the pid is alive, its command line is a Next dev server, and
 * it belongs to this checkout. A live pid that only *looks* like Next (another checkout, a
 * recycled pid, `tail -f app.next.log`) is `unknown`: worth a warning, never a kill.
 */
export function classifyLock(text: string | null, probe: LockProbe): LockState {
  if (text === null) return { kind: "absent" };

  const info = parseLockInfo(text);
  if (!info) return { kind: "unreadable" };
  if (!probe.alive(info.pid)) return { kind: "stale", pid: info.pid, port: info.port };

  const cmdline = probe.cmdline(info.pid);
  if (cmdline === null) {
    return { kind: "unknown", pid: info.pid, reason: "进程在，但读不到它的命令行" };
  }
  if (!NEXT_PROCESS_PATTERN.test(cmdline)) {
    return {
      kind: "unknown",
      pid: info.pid,
      reason: `PID 已被别的进程复用：${shorten(cmdline)}`,
    };
  }
  if (!probe.ownedByRepo(info.pid)) {
    return {
      kind: "unknown",
      pid: info.pid,
      reason: `命令行像 Next，但工作目录不是本仓库的 service/（另一个 checkout？）：${shorten(cmdline)}`,
    };
  }

  return {
    kind: "running",
    pid: info.pid,
    port: info.port,
    appUrl: info.appUrl,
    startedAt: info.startedAt,
    listening: probe.listening(info.port),
  };
}

export function inspectDevLock(
  serviceDir: string,
  probe: LockProbe = defaultProbe(serviceDir),
): LockState {
  const lockPath = devLockPath(serviceDir);
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
  return classifyLock(text, probe);
}

/** Human-readable report lines. The caller decides whether they are fatal. */
export function formatLockReport(state: LockState, lockPath: string): string[] {
  const shown = displayPath(lockPath);

  switch (state.kind) {
    case "absent":
      return [`dev: ${shown} 不存在 — 没有 Next dev 在跑`];
    case "unreadable":
      return [
        `dev: ${shown} 存在但内容读不出来（可能正在写入）`,
        "     没有可靠办法判断占用者，所以不删它",
        "     若 Next 报 Another next dev server is already running，确认没有 dev 在跑后手工删掉它",
      ];
    case "stale":
      return [
        `dev: ${shown} 是上次异常退出留下的：pid ${state.pid} 已经不存在`,
        "     锁随进程一起释放了，删掉它继续启动",
      ];
    case "unknown":
      return [
        `dev: ${shown} 里的 pid ${state.pid} 还活着，但不是本仓库的 Next（${state.reason}）`,
        "     按「不是我们的进程」处理：不删锁、也不会动它",
        `     确认没有 dev 在服务后，手工删掉 ${shown} 再启动（Next 会重写它）`,
      ];
    case "running": {
      const owner = [`pid ${state.pid}`];
      const description = describeProcess(state.pid);
      if (description) owner.push(description);
      if (state.appUrl) owner.push(state.appUrl);
      if (state.startedAt > 0) owner.push(`启动于 ${formatTimestamp(state.startedAt)}`);

      const portLine = state.listening
        ? `:${state.port} 有进程在监听 → 它正在服务，不是残留`
        : `:${state.port} 当前空闲 → 它正在退出，不是在服务`;

      return [
        `dev: ${shown} 被另一个 Next dev 进程持有`,
        `     ${owner.join(" · ")}`,
        `     ${portLine}`,
        "     停止它：bun run dev:stop      （SIGTERM 给 next-dev 父进程，10s 后升级 SIGKILL）",
        "     立即强杀：bun run dev:stop --force",
      ];
    }
  }
}

/** Deletes the lock file only when it is provably stale. Returns whether it unlinked. */
export function removeStaleLock(state: LockState, lockPath: string): boolean {
  if (state.kind !== "stale") return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Short label for a live pid, e.g. `next-server (v16.4.3)`. */
export function describeProcess(pid: number): string | null {
  const cmdline = readProcessCmdline(pid);
  if (!cmdline) return null;
  const titled = cmdline.match(/next-(?:server|dev)\s*\(v[^)]*\)/);
  return titled ? titled[0] : shorten(cmdline);
}

function parseLockInfo(
  text: string,
): { pid: number; port: number; appUrl: string; startedAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;

  const port = typeof record.port === "number" ? record.port : 0;
  const appUrl = typeof record.appUrl === "string" ? record.appUrl : "";
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
  return { pid, port, appUrl, startedAt };
}

/** Local time, `YYYY-MM-DD HH:mm:ss` — stable across locales and CI. */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "未知";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Path relative to the cwd when it is inside it, absolute otherwise. */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return path;
}

function shorten(text: string, limit = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** `/proc/<pid>/cwd` appends ` (deleted)` once the directory is gone; compare the path only. */
function stripDeletedSuffix(path: string): string {
  const suffix = " (deleted)";
  return path.endsWith(suffix) ? path.slice(0, -suffix.length) : path;
}

function linuxPortListening(port: number): boolean {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      // fields[1] = "0100007F:0FA0", fields[3] = "0A" (TCP_LISTEN).
      if (fields[3] !== "0A") continue;
      if (fields[1].endsWith(`:${hex}`)) return true;
    }
  }
  return false;
}

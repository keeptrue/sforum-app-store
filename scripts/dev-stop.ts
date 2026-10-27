/**
 * `bun run dev:stop` — stop what `bun run dev` started, including an orphaned next-server.
 *
 * Two independent records point at those processes, and either can be the only survivor:
 *
 * - `tmp/supervise.json` (written by `scripts/supervise.ts`) names the supervisor and the
 *   process-group leaders it spawned;
 * - `service/.next/dev/lock` names the `next-server` that holds the dev lock. It is the only
 *   trace left when the supervisor itself was killed.
 *
 * Everything is killed by pid or by process group — never `pkill -f`, which would also take
 * out the shell that ran it. A pid is signalled only after its command line matches what the
 * record claims, so a recycled pid from an unrelated process is never hit.
 *
 * When the lock itself is unreadable but :4000 still answers, the listener is used as the last
 * resort — again only after its cwd and command line prove it is this repo's dev server.
 *
 *   bun run dev:stop          # SIGTERM, wait up to 10s, then SIGKILL
 *   bun run dev:stop --force  # SIGKILL straight away
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  devLockPath,
  displayPath,
  findPortListenerPid,
  findRepoProcesses,
  inspectDevLock,
  isPortListening,
  isProcessAlive,
  isRepoProcess,
  NEXT_DEV_CLI_PATTERN,
  readParentPid,
  readProcessCmdline,
  readProcessSession,
  readProcessTree,
  readSessionMembers,
  removeStaleLock,
} from "./dev-lock";

/** Grace before SIGKILL, matching the supervisor's own shutdown budget. */
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 2_000;
const DEFAULT_PORT = 4000;

type SupervisedChild = { label: string; pid: number; script: string };
type SuperviseRecord = { supervisor: number; children: SupervisedChild[] };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = join(repoRoot, "service");
const pidFile = join(repoRoot, "tmp", "supervise.json");
const lockPath = devLockPath(serviceDir);
const force = process.argv.slice(2).includes("--force");

let port = DEFAULT_PORT;

const record = readSuperviseRecord(pidFile);
const supervisorRunning =
  record !== null && isProcessAlive(record.supervisor) && cmdlineHas(record.supervisor, "supervise.ts");

// Path A: the supervisor tears its own groups down, so it is the cleanest way out.
if (record !== null) {
  if (supervisorRunning) {
    await stopProcesses([record.supervisor], {
      label: "supervisor",
      force,
      timeoutMs: STOP_TIMEOUT_MS,
    });
  } else if (isProcessAlive(record.supervisor)) {
    console.warn(
      `dev:stop: ${displayPath(pidFile)} 里的 pid ${record.supervisor} 已被别的进程复用，跳过它`,
    );
  }

  // A killed supervisor leaves its children behind; they are still ours, but prove it first.
  for (const child of record.children) {
    await stopProcesses(ownedPids(child), {
      label: child.label,
      force,
      timeoutMs: STOP_TIMEOUT_MS,
    });
  }
} else if (existsSync(pidFile)) {
  console.warn(`dev:stop: ${displayPath(pidFile)} 解析不了，按「没有 pidfile」处理`);
}

// Path B: the dev lock. Covers a supervisor that was killed and left next-server behind.
let lockState = inspectDevLock(serviceDir);
let foreignLock = false;
if (lockState.kind === "unknown") {
  // Alive but not provably this checkout's Next (another checkout, a recycled pid, a process
  // whose command line merely contains "next"). Reporting it is all we may do.
  foreignLock = true;
  console.warn(
    `dev:stop: 锁里的 pid ${lockState.pid} 不是本仓库的 Next（${lockState.reason}），不动它`,
  );
  console.warn(`dev:stop: 确认没有 dev 在服务后，手工删掉 ${displayPath(lockPath)}`);
}
if (lockState.kind === "running") {
  if (lockState.port > 0) port = lockState.port;

  const target = pickLockTarget(lockState.pid);
  if (target === null) {
    // The pid is alive and looks like Next, but its cwd/command line is not this checkout's.
    // Killing it would be killing someone else's server, so only report.
    foreignLock = true;
    console.warn(
      `dev:stop: 锁里的 pid ${lockState.pid} 不是本仓库的 Next（cwd 不在 service/ 或命令行对不上），不动它`,
    );
    console.warn(`dev:stop: 确认没有 dev 在服务后，手工删掉 ${displayPath(lockPath)}`);
  } else {
    await stopProcesses(lockPids(lockState.pid, target.pid), {
      label: target.label,
      force,
      timeoutMs: STOP_TIMEOUT_MS,
    });
    lockState = inspectDevLock(serviceDir);
  }
}

// Path C: the lock is unusable (unreadable / absent) but :4000 still answers. The listener is
// the only process that can be the server, and it is killed only when its cwd and command line
// prove it is this repo's — an unrelated :4000 keeps running and gets reported instead.
if (lockState.kind !== "running" && isPortListening(port)) {
  const holder = findPortListenerPid(port);
  if (holder !== null && isRepoProcess(holder, serviceDir)) {
    await stopProcesses(portOwnerPids(holder), {
      label: `:${port} 的占用者`,
      force,
      timeoutMs: STOP_TIMEOUT_MS,
    });
    lockState = inspectDevLock(serviceDir);
  }
}

// Only delete the lock once the pid it names is provably gone — and only while no repo next
// process still listens on the lock's port, because a CLI that escaped our session could still
// hold the same flock (unlinking would let a second dev lock a fresh inode).
if (lockState.kind === "stale") {
  const listener = lockState.port > 0 ? findPortListenerPid(lockState.port) : null;
  if (listener !== null && isRepoProcess(listener, serviceDir)) {
    console.warn(
      `dev:stop: ${displayPath(lockPath)} 的属主已退出，但 :${lockState.port} 仍有本仓库的 next 在监听（pid ${listener}），先不删锁`,
    );
  } else {
    try {
      if (removeStaleLock(lockState, lockPath)) {
        console.log(`dev:stop: 已删除 ${displayPath(lockPath)}（pid ${lockState.pid} 已退出）`);
      }
    } catch (error) {
      console.warn(`dev:stop: 删不掉 ${displayPath(lockPath)}：${message(error)}`);
    }
  }
}

// An unreadable lock is provably garbage once nothing in this checkout can be holding it: no
// repo dev process is alive and the port is free. The preflight has no such evidence, so it
// keeps the file and lets Next rewrite it; `dev:stop` has to leave the state clean instead.
if (
  lockState.kind === "unreadable" &&
  !isPortListening(port) &&
  findRepoProcesses(serviceDir).length === 0
) {
  try {
    unlinkSync(lockPath);
    console.log(
      `dev:stop: 已删除读不出内容的 ${displayPath(lockPath)}（本仓库没有 dev 进程、:${port} 空闲）`,
    );
    lockState = inspectDevLock(serviceDir);
  } catch (error) {
    console.warn(`dev:stop: 删不掉 ${displayPath(lockPath)}：${message(error)}`);
  }
}

const supervisorStillRunning =
  record !== null && isProcessAlive(record.supervisor) && cmdlineHas(record.supervisor, "supervise.ts");

if (!supervisorStillRunning) {
  try {
    rmSync(pidFile, { force: true });
  } catch (error) {
    console.warn(`dev:stop: 删不掉 ${displayPath(pidFile)}：${message(error)}`);
  }
}

const lockLeft = existsSync(lockPath) && !foreignLock;
const pidFileLeft = existsSync(pidFile);
const portBusy = isPortListening(port);

if (portBusy) {
  const holder = findPortListenerPid(port);
  const holderCmdline = holder === null ? null : readProcessCmdline(holder);
  const who =
    holder === null
      ? ""
      : `（pid ${holder}${holderCmdline ? ` · ${holderCmdline}` : ""}）`;
  const verdict =
    holder === null
      ? "，无法确定占用者"
      : isRepoProcess(holder, serviceDir)
        ? "，它仍属于本仓库（还有别的 dev 在跑？用 bun run dev:stop --force）"
        : "，它不是本仓库的 Next dev，没有动它";
  console.warn(`dev:stop: :${port} 仍被占用${who}${verdict}`);
} else {
  console.log(`dev:stop: :${port} 空闲`);
}

if (lockLeft) {
  console.warn(`dev:stop: 锁还在：${displayPath(lockPath)}`);
} else if (foreignLock) {
  console.log(`dev:stop: 锁指向的不是本仓库的进程，没有动它（文件仍在，确认后手工删）`);
} else {
  console.log(`dev:stop: 锁已清：${displayPath(lockPath)} 不存在`);
}

if (pidFileLeft) {
  console.warn(`dev:stop: ${displayPath(pidFile)} 还在（supervisor 没有正常退出）`);
}

process.exitCode = portBusy || lockLeft || pidFileLeft ? 1 : 0;

/**
 * The lock pid is `next-server`; its parent is the `next dev` CLI. Signalling the parent is
 * the graceful path (it reaps its child), so prefer it when the command line says `next`.
 * Returns null when neither pid is provably this checkout's — the lock is then reported and
 * left alone, never killed on the strength of a command-line substring.
 */
function pickLockTarget(lockPid: number): { pid: number; label: string } | null {
  if (!isRepoProcess(lockPid, serviceDir)) return null;

  const parent = readParentPid(lockPid);
  if (parent !== null && parent > 1 && isRepoProcess(parent, serviceDir)) {
    const cmdline = readProcessCmdline(parent);
    if (cmdline !== null && NEXT_DEV_CLI_PATTERN.test(cmdline)) {
      return { pid: parent, label: "next-dev 父进程" };
    }
  }
  return { pid: lockPid, label: "next-server" };
}

/**
 * Pids that belong to a recorded child. The `bun run --filter` wrapper puts the real script in
 * a new process group but keeps the session the child created, and a session survives
 * reparenting — that is how an orphaned worker is found after the supervisor was killed.
 * The session id is only trusted while the root is verifiably ours; otherwise each member has
 * to prove it is this repo's process (cwd + command line), so a recycled pid is never hit.
 */
function ownedPids(child: SupervisedChild): number[] {
  // Both halves of the command line have to match: `worker` alone is a word any daemon can
  // carry, while `bun run --no-orphans worker` is the exact wrapper this supervisor spawned.
  const rootTrusted =
    isProcessAlive(child.pid) &&
    cmdlineHas(child.pid, "--no-orphans") &&
    cmdlineHas(child.pid, child.script);
  const pids = new Set<number>();

  if (rootTrusted) {
    pids.add(child.pid);
    for (const pid of readProcessTree(child.pid)) pids.add(pid);
  }
  for (const pid of readSessionMembers(child.pid)) {
    if (rootTrusted || isRepoProcess(pid, serviceDir)) pids.add(pid);
  }

  pids.delete(process.pid);
  pids.delete(1);
  return [...pids];
}

/** The lock owner plus its parent, plus anything else the same session proves is ours. */
function lockPids(lockPid: number, parentPid: number): number[] {
  const pids = new Set<number>([lockPid, parentPid]);
  const session = readProcessSession(lockPid);
  if (session !== null && session !== readProcessSession(process.pid)) {
    for (const pid of readSessionMembers(session)) {
      if (isRepoProcess(pid, serviceDir)) pids.add(pid);
    }
  }
  pids.delete(process.pid);
  pids.delete(1);
  return [...pids];
}

/** The port owner and the rest of its session that is provably this repo's. */
function portOwnerPids(ownerPid: number): number[] {
  const pids = new Set<number>([ownerPid]);
  const session = readProcessSession(ownerPid);
  if (session !== null && session !== readProcessSession(process.pid)) {
    for (const pid of readSessionMembers(session)) {
      if (isRepoProcess(pid, serviceDir)) pids.add(pid);
    }
  }
  pids.delete(process.pid);
  pids.delete(1);
  return [...pids];
}

async function stopProcesses(
  pids: number[],
  options: { label: string; force: boolean; timeoutMs: number },
): Promise<void> {
  const alive = [...new Set(pids)].filter((pid) => pid > 1 && pid !== process.pid && isProcessAlive(pid));
  if (alive.length === 0) return;

  const signal: NodeJS.Signals = options.force ? "SIGKILL" : "SIGTERM";
  console.log(`dev:stop: 停止 ${options.label}（pid ${alive.join("、")}，${signal}）`);
  signalPids(alive, signal);

  const timeout = options.force ? KILL_TIMEOUT_MS : options.timeoutMs;
  if (await waitFor(() => alive.every((pid) => !isProcessAlive(pid)), timeout)) return;

  const stuck = alive.filter(isProcessAlive);
  console.warn(`dev:stop: pid ${stuck.join("、")} 没在 ${timeout / 1000}s 内退出，升级 SIGKILL`);
  signalPids(stuck, "SIGKILL");
  await waitFor(() => stuck.every((pid) => !isProcessAlive(pid)), KILL_TIMEOUT_MS);
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    if (process.platform === "win32" && signal === "SIGKILL") {
      // No sessions/process groups to walk: kill the tree the hard way.
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function cmdlineHas(pid: number, needle: string): boolean {
  const cmdline = readProcessCmdline(pid);
  return cmdline !== null && cmdline.includes(needle);
}

function readSuperviseRecord(path: string): SuperviseRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const raw = parsed as Record<string, unknown>;
  const supervisor = raw.supervisor;
  if (typeof supervisor !== "number" || !Number.isInteger(supervisor) || supervisor <= 0) {
    return null;
  }

  const rawChildren = Array.isArray(raw.children) ? raw.children : [];
  const children: SupervisedChild[] = [];
  for (const item of rawChildren) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const pid = entry.pid;
    const script = entry.script;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (typeof script !== "string" || script.length === 0) continue;
    children.push({ label: typeof entry.label === "string" ? entry.label : script, pid, script });
  }

  return { supervisor, children };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  return check();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

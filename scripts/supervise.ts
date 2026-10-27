/**
 * `bun run dev` / `bun run start` — run several package scripts as one supervised group.
 *
 * `bun run --parallel --no-orphans` is not enough for this repo:
 *
 * - it does not fail fast. When `dev:web` dies the command still waits for `worker`, which
 *   never exits on its own, so the terminal hangs on a dev server that is already gone;
 * - it cannot clean up a Next dev server. `next dev` keeps a `next-server` child that
 *   survives the CLI it was started from (reparented to init) and keeps holding both
 *   `service/.next/dev/lock` and :4000, so the next `bun run dev` reports
 *   `Another next dev server is already running` on an idle port.
 *
 * So each script runs in its own session with prefixed output, the pids land in
 * `tmp/supervise.json` for `bun run dev:stop`, and the first exit (or SIGINT/SIGTERM/SIGHUP)
 * tears the whole tree down — SIGTERM, 5s, SIGKILL — then makes sure the dev lock is gone.
 *
 *   bun run scripts/supervise.ts dev:web worker
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  devLockPath,
  displayPath,
  findPortListenerPid,
  formatLockReport,
  inspectDevLock,
  isProcessAlive,
  isRepoProcess,
  readProcessCmdline,
  readProcessSession,
  readProcessTree,
  readSessionMembers,
  removeStaleLock,
} from "./dev-lock";

/** SIGTERM grace before a stuck child group is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;
/** How long to keep watching after SIGKILL before giving up on the group. */
const KILL_WAIT_MS = 2_000;
/** Exit codes for the signals we forward: 128 + signal number, the shell convention. */
const SIGNAL_EXIT_CODES: Array<[NodeJS.Signals, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = join(repoRoot, "service");
const pidFile = join(repoRoot, "tmp", "supervise.json");

const USAGE = `用法：
  bun run scripts/supervise.ts <script> [<script>...]

每个参数既是要跑的 package.json 脚本名，也是它的输出前缀：
  bun run scripts/supervise.ts dev:web worker

第一个子进程退出（或收到 SIGINT/SIGTERM/SIGHUP）时，其余进程连同整棵树一起收尾：
SIGTERM → 等 5 秒 → SIGKILL，然后清掉 service/.next/dev/lock 里已经死掉的锁。
`;

type Supervised = {
  label: string;
  script: string;
  pid: number;
  child: ChildProcess;
};

let shuttingDown = false;
const children: Supervised[] = [];

const scripts = process.argv.slice(2).filter((arg) => arg !== "--");
if (scripts.length === 0 || scripts.includes("--help") || scripts.includes("-h")) {
  console.log(USAGE);
  process.exitCode = scripts.length === 0 ? 1 : 0;
} else {
  await run(scripts);
}

async function run(names: string[]): Promise<void> {
  if (names.includes("dev:web") && !preflightDevLock()) return;

  console.log(
    `supervise: 启动 ${names.join("、")}（pid 记录在 ${displayPath(pidFile)}）`,
  );

  // Registered before the first spawn: a Ctrl-C during startup must not leave a child behind.
  for (const [signal, code] of SIGNAL_EXIT_CODES) {
    process.on(signal, () => {
      void shutdown(code, `收到 ${signal}`);
    });
  }

  const width = Math.max(...names.map((name) => name.length));
  for (const script of names) {
    const child = spawn(process.execPath, ["run", "--no-orphans", script], {
      cwd: repoRoot,
      // `detached` gives the script its own session. That is the handle that still reaches
      // next-server: `bun run --filter` moves the real script into a new process group, so a
      // group kill would only ever hit the `bun run` wrapper.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid === undefined) {
      console.error(`supervise: 起不来 ${script}`);
      void shutdown(1, `${script} 启动失败`);
      return;
    }

    const entry: Supervised = { label: script, script, pid: child.pid, child };
    children.push(entry);

    if (child.stdout) pipeWithPrefix(child.stdout, script, width, process.stdout);
    if (child.stderr) pipeWithPrefix(child.stderr, script, width, process.stderr);

    child.on("exit", (code, signal) => onChildExit(entry, code, signal));
    child.on("error", (error) => {
      console.error(`supervise: ${script} 启动失败：${message(error)}`);
      void shutdown(1, `${script} 启动失败`);
    });
  }

  writePidFile();
}

/**
 * Refuses to start a second dev server while the lock is held by a live one. Next binds the
 * port *before* it takes the lock, so the failure mode without this check is a "Ready" banner
 * followed by exit 1 — and an idle-looking port.
 */
function preflightDevLock(): boolean {
  const lockPath = devLockPath(serviceDir);
  const state = inspectDevLock(serviceDir);
  if (state.kind === "absent") return true;

  const lines = formatLockReport(state, lockPath);

  if (state.kind === "stale") {
    for (const line of lines) console.log(line);
    try {
      removeStaleLock(state, lockPath);
    } catch (error) {
      console.warn(`dev: 删不掉 ${displayPath(lockPath)}（${message(error)}），继续启动`);
    }
    return true;
  }

  const report = state.kind === "running" ? console.error : console.warn;
  for (const line of lines) report(line);

  if (state.kind === "running") {
    process.exitCode = 1;
    return false;
  }
  // `unreadable` / `unknown`: nothing proves the lock is ours to delete, so warn and try.
  return true;
}

function onChildExit(
  entry: Supervised,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (shuttingDown) return;
  const detail = code !== null ? `退出码 ${code}` : `被 ${signal ?? "信号"} 结束`;
  void shutdown(code ?? 1, `${entry.label} ${detail}`);
}

async function shutdown(code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  collectTargets();
  const remaining = children
    .filter((entry) => (targets.get(entry) ?? []).some(isProcessAlive))
    .map((entry) => entry.label);
  console.log(
    `supervise: ${reason}；停止 ${remaining.length > 0 ? remaining.join("、") : "（没有其它进程）"}`,
  );

  signalAll("SIGTERM");
  if (!(await waitForTargets(SHUTDOWN_GRACE_MS))) {
    console.warn(`supervise: ${SHUTDOWN_GRACE_MS / 1000}s 内没有全部退出，升级 SIGKILL`);
    collectTargets();
    signalAll("SIGKILL");
    await waitForTargets(KILL_WAIT_MS);
  }

  await settleDevLock();
  removePidFile();
  await flush();
  process.exit(code);
}

/**
 * Snapshot of the pids that belong to each child. Taken before signalling because a killed
 * parent reparents its children to init, which erases the parent links we would walk.
 */
let targets = new Map<Supervised, number[]>();

function collectTargets(): void {
  targets = new Map(children.map((entry) => [entry, ownedPids(entry)]));
}

/**
 * `bun run --filter` moves the real script into a new process group but keeps the session our
 * `detached` child created — so the session is what still reaches `next-server` after it was
 * reparented, while the process group only ever held the `bun run` wrapper. Elsewhere the
 * session id is unknown and the tree walk is the fallback.
 */
function ownedPids(entry: Supervised): number[] {
  const members = readSessionMembers(entry.pid);
  const pids = new Set<number>(members.length > 0 ? members : readProcessTree(entry.pid));
  pids.add(entry.pid);
  pids.delete(process.pid);
  pids.delete(1);
  return [...pids];
}

function signalAll(signal: NodeJS.Signals): void {
  for (const entry of children) {
    signalEntry(entry, targets.get(entry) ?? ownedPids(entry), signal);
  }
}

function signalEntry(entry: Supervised, pids: number[], signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No sessions to enumerate on Windows: the tree has to be walked by taskkill.
    if (signal === "SIGKILL") {
      try {
        execFileSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      entry.child.kill(signal);
    } catch {
      // Already gone.
    }
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function waitForTargets(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const alive = [...targets.values()].flat().filter(isProcessAlive);
    if (alive.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * The session kill normally takes next-server with it. If one escaped, only touch it when the
 * snapshot (or its session) proves it is ours — never a recycled pid from someone else.
 */
async function settleDevLock(): Promise<void> {
  if (!scripts.includes("dev:web")) return;

  const lockPath = devLockPath(serviceDir);
  let state = inspectDevLock(serviceDir);

  if (state.kind === "running") {
    // Narrowed once: the callbacks below would otherwise lose the `kind` refinement.
    const lockPid = state.pid;
    const ours =
      [...targets.values()].some((pids) => pids.includes(lockPid)) ||
      children.some((entry) => readProcessSession(lockPid) === entry.pid);
    if (!ours) {
      console.warn(`supervise: 锁仍被 pid ${lockPid} 持有，但它不是本次启动的进程，没有动它`);
      console.warn("supervise: 需要清场时运行 bun run dev:stop --force");
      return;
    }
    try {
      process.kill(lockPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await waitForPid(lockPid, KILL_WAIT_MS);
    state = inspectDevLock(serviceDir);
  }

  if (state.kind !== "stale") return;

  // The pid is gone, but the flock can outlive it: a `next dev` CLI that left our session may
  // still hold the same inode. Unlinking then would let a second dev lock a fresh inode and
  // write the same .next/dev, so only unlink while no repo next process is listening.
  const listener = state.port > 0 ? findPortListenerPid(state.port) : null;
  if (listener !== null && isRepoProcess(listener, serviceDir)) {
    console.warn(
      `supervise: ${displayPath(lockPath)} 的属主已退出，但 :${state.port} 仍有本仓库的 next 在监听（pid ${listener}），先不删锁`,
    );
    return;
  }

  try {
    if (removeStaleLock(state, lockPath)) {
      console.log(`supervise: 已删除 ${displayPath(lockPath)}（pid ${state.pid} 已退出）`);
    }
  } catch (error) {
    console.warn(`supervise: 删不掉 ${displayPath(lockPath)}：${message(error)}`);
  }
}

/**
 * One slot, so a second supervisor must not clobber the record of a live one: `dev:stop` reads
 * this file to find the supervisor, and the loser of the dev-lock race exits immediately.
 */
function writePidFile(): void {
  const owner = readPidFileOwner(pidFile);
  if (
    owner !== null &&
    owner !== process.pid &&
    isProcessAlive(owner) &&
    cmdlineHas(owner, "supervise.ts")
  ) {
    console.warn(
      `supervise: ${displayPath(pidFile)} 属于另一个 supervisor（pid ${owner}），不覆盖它`,
    );
    return;
  }

  const payload = {
    supervisor: process.pid,
    startedAt: Date.now(),
    children: children.map((entry) => ({
      label: entry.label,
      pid: entry.pid,
      script: entry.script,
    })),
  };
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    // `dev:stop` still has the dev lock to fall back on; do not fail the run over this.
    console.warn(`supervise: 写 ${displayPath(pidFile)} 失败（不影响运行）：${message(error)}`);
  }
}

/** Only removes the file this supervisor wrote — never another supervisor's record. */
function removePidFile(): void {
  const owner = readPidFileOwner(pidFile);
  if (owner !== null && owner !== process.pid) return;
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // Best effort: the next run overwrites it.
  }
}

function readPidFileOwner(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { supervisor?: unknown };
    const owner = parsed.supervisor;
    return typeof owner === "number" && Number.isInteger(owner) && owner > 0 ? owner : null;
  } catch {
    return null;
  }
}

function cmdlineHas(pid: number, needle: string): boolean {
  const cmdline = readProcessCmdline(pid);
  return cmdline !== null && cmdline.includes(needle);
}

function pipeWithPrefix(
  stream: Readable,
  label: string,
  width: number,
  target: NodeJS.WriteStream,
): void {
  let buffer = "";
  const prefix = label.padEnd(width);
  const emit = (line: string): void => {
    target.write(line.length === 0 ? `${prefix} |\n` : `${prefix} | ${line}\n`);
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      emit(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length === 0) return;
    emit(buffer.replace(/\r$/, ""));
    buffer = "";
  });
}

async function waitForPid(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

/** `process.exit` drops queued pipe writes; give the streams one turn to drain. */
async function flush(): Promise<void> {
  const drain = (stream: NodeJS.WriteStream) =>
    new Promise<void>((resolveDrain) => {
      try {
        stream.write("", () => resolveDrain());
      } catch {
        resolveDrain();
      }
    });
  await Promise.race([Promise.all([drain(process.stdout), drain(process.stderr)]), sleep(250)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalPath,
  classifyLock,
  devLockPath,
  formatLockReport,
  isPortListening,
  isProcessAlive,
  isRepoProcess,
  readProcessCmdline,
  removeStaleLock,
  type LockProbe,
} from "./dev-lock";

const LOCK_PATH = "/repo/service/.next/dev/lock";

function lockText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4242,
    port: 4000,
    hostname: "localhost",
    appUrl: "http://localhost:4000",
    startedAt: Date.UTC(2026, 9, 26, 19, 37, 26),
    ...overrides,
  });
}

/** Default probe: a live Next dev server on :4000 that belongs to this checkout. */
function probe(overrides: Partial<LockProbe> = {}): LockProbe {
  return {
    alive: () => true,
    cmdline: () => "next-server (v16.4.3)",
    listening: () => true,
    ownedByRepo: () => true,
    ...overrides,
  };
}

describe("classifyLock", () => {
  test("missing file is absent", () => {
    const state = classifyLock(null, probe());
    expect(state).toEqual({ kind: "absent" });
    expect(formatLockReport(state, LOCK_PATH)[0]).toContain("不存在");
  });

  test("malformed body is unreadable and never deleted", () => {
    for (const text of ["", "{not json", '{"pid":"4242"}', '{"port":4000}', "null"]) {
      const state = classifyLock(text, probe());
      expect(state).toEqual({ kind: "unreadable" });
      expect(removeStaleLock(state, LOCK_PATH)).toBe(false);
    }
    const lines = formatLockReport({ kind: "unreadable" }, LOCK_PATH);
    expect(lines.join("\n")).toContain("不删它");
  });

  test("dead pid is stale and removable", () => {
    const state = classifyLock(lockText(), probe({ alive: () => false }));
    expect(state).toEqual({ kind: "stale", pid: 4242, port: 4000 });
    const lines = formatLockReport(state, LOCK_PATH);
    expect(lines.join("\n")).toContain("pid 4242 已经不存在");
  });

  test("live next dev server is running", () => {
    const state = classifyLock(lockText(), probe());
    expect(state).toEqual({
      kind: "running",
      pid: 4242,
      port: 4000,
      appUrl: "http://localhost:4000",
      startedAt: Date.UTC(2026, 9, 26, 19, 37, 26),
      listening: true,
    });
    const lines = formatLockReport(state, LOCK_PATH);
    expect(lines[0]).toContain("被另一个 Next dev 进程持有");
    expect(lines.join("\n")).toContain("正在服务，不是残留");
    expect(lines.join("\n")).toContain("bun run dev:stop");
    expect(lines.join("\n")).toContain("bun run dev:stop --force");
  });

  test("running but idle port is reported as exiting, not serving", () => {
    const state = classifyLock(lockText(), probe({ listening: () => false }));
    expect(state.kind).toBe("running");
    if (state.kind !== "running") throw new Error("expected running");
    expect(state.listening).toBe(false);
    const report = formatLockReport(state, LOCK_PATH).join("\n");
    expect(report).toContain(":4000 当前空闲 → 它正在退出，不是在服务");
    expect(report).not.toContain("正在服务，不是残留");
  });

  test("live pid reused by an unrelated process is unknown and never deleted", () => {
    const state = classifyLock(
      lockText(),
      probe({ cmdline: () => "/usr/lib/postgresql/17/bin/postgres -D /var/lib/pg" }),
    );
    expect(state.kind).toBe("unknown");
    if (state.kind !== "unknown") throw new Error("expected unknown");
    expect(state.pid).toBe(4242);
    expect(state.reason).toContain("PID 已被别的进程复用");
    expect(removeStaleLock(state, LOCK_PATH)).toBe(false);
    const report = formatLockReport(state, LOCK_PATH).join("\n");
    expect(report).toContain("不删锁、也不会动它");
  });

  test("a command line that merely contains 'next' is not a dev server", () => {
    for (const cmdline of [
      "tail -f /tmp/lcs.next-dev.log",
      "vim service/.next/dev/lock",
      "node /home/x/next-tools/cli.js --watch",
    ]) {
      const state = classifyLock(lockText(), probe({ cmdline: () => cmdline }));
      expect(state.kind).toBe("unknown");
      if (state.kind !== "unknown") throw new Error("expected unknown");
      expect(state.reason).toContain("PID 已被别的进程复用");
    }
  });

  test("a Next dev server from another checkout is unknown, not running", () => {
    const state = classifyLock(lockText(), probe({ ownedByRepo: () => false }));
    expect(state.kind).toBe("unknown");
    if (state.kind !== "unknown") throw new Error("expected unknown");
    expect(state.reason).toContain("工作目录不是本仓库");

    const report = formatLockReport(state, LOCK_PATH).join("\n");
    expect(report).toContain("不删锁、也不会动它");
    expect(report).toContain("手工删掉");
    expect(report).not.toContain("--force");
  });

  test("both shapes of the next dev CLI classify as running", () => {
    for (const cmdline of [
      "node /repo/service/node_modules/.bin/next dev -p 4000",
      "node /repo/service/node_modules/next/dist/bin/next dev -p 4000",
    ]) {
      expect(classifyLock(lockText(), probe({ cmdline: () => cmdline })).kind).toBe("running");
    }
  });

  test("live pid with no readable command line is unknown", () => {
    const state = classifyLock(lockText(), probe({ cmdline: () => null }));
    expect(state.kind).toBe("unknown");
    if (state.kind !== "unknown") throw new Error("expected unknown");
    expect(state.reason).toContain("读不到");
  });

  test("lock text without appUrl still classifies", () => {
    const state = classifyLock('{"pid":4242,"port":4000}', probe());
    expect(state.kind).toBe("running");
    if (state.kind !== "running") throw new Error("expected running");
    expect(state.appUrl).toBe("");
    expect(state.startedAt).toBe(0);
    expect(formatLockReport(state, LOCK_PATH).join("\n")).not.toContain("启动于");
  });
});

describe("removeStaleLock", () => {
  test("unlinks only a stale lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-lock-"));
    try {
      const serviceDir = join(dir, "service");
      const lockPath = devLockPath(serviceDir);
      mkdirSync(join(serviceDir, ".next", "dev"), { recursive: true });

      writeFileSync(lockPath, lockText());
      expect(removeStaleLock({ kind: "running", pid: 4242, port: 4000, appUrl: "", startedAt: 0, listening: true }, lockPath)).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toContain("4242");

      expect(removeStaleLock({ kind: "stale", pid: 4242, port: 4000 }, lockPath)).toBe(true);
      expect(() => readFileSync(lockPath, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isRepoProcess", () => {
  test("canonicalPath resolves a symlinked checkout to the same directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-lock-link-"));
    try {
      const real = join(dir, "real-service");
      const link = join(dir, "link-service");
      mkdirSync(real);
      symlinkSync(real, link, "dir");
      expect(canonicalPath(link)).toBe(canonicalPath(real));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux")(
    "needs the service dir cwd, follows symlinks, and degrades to the command line when cwd is unreadable",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dev-lock-repo-"));
      const real = join(dir, "real-service");
      const link = join(dir, "link-service");
      mkdirSync(real);
      symlinkSync(real, link, "dir");

      // A process whose command line looks exactly like a Next dev server.
      const child = spawn("bash", ["-c", 'exec -a "next-server (v16.4.3)" sleep 10'], {
        cwd: real,
        stdio: "ignore",
      });
      try {
        await waitForCommandLine(child.pid!, "next-server");
        expect(isRepoProcess(child.pid!, real)).toBe(true);
        expect(isRepoProcess(child.pid!, link)).toBe(true);
        expect(isRepoProcess(child.pid!, join(dir, "another-checkout"))).toBe(false);
        // cwd unreadable (macOS without lsof, hidepid): the command line has to decide.
        expect(isRepoProcess(child.pid!, join(dir, "another-checkout"), () => null)).toBe(true);
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

async function waitForCommandLine(pid: number, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const cmdline = readProcessCmdline(pid);
    if (cmdline !== null && cmdline.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} never showed "${needle}"`);
}

describe("process and port probes", () => {
  test("isProcessAlive sees this process and rejects a pid that cannot exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("isPortListening finds a live listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      expect(isPortListening(address.port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(isPortListening(address.port)).toBe(false);
  });
});

# dev 用自研 supervisor，Next dev 锁用 `dev:stop` 收

Status: accepted
Date: 2026-10-27

## 背景

2026-10-27 03:37 起的一个 `next-server` 在 05:00 仍持有 `service/.next/dev/lock`、占着 4000。
新的 `bun run dev` 绑上 4000、打印 `Ready`，随后报 `Another next dev server is already running.`
并 `exit 1` —— 端口是新的那个进程刚 listen 的，锁在旧的那个进程手里，两个现象同时成立。

同一窗口里照 Next 的提示 `kill <锁里的 pid>` 试了三次，锁一次都没释放；而
`bun run --parallel --no-orphans` 在 `dev:web` 死后不会停掉 worker，终端只能整个杀掉。

三个事实决定了修法：

1. **锁是 Next 的默认行为，且排在 `listen` 之后。** Next 16.4.3
   `experimental.lockDistDir` 默认 `true`（`next/dist/server/config-shared.js:287`）；`next dev`
   在端口起来之后才 `Lockfile.acquireWithRetriesOrExit` 拿 `distDir/lock`
   （`next/dist/server/lib/router-utils/setup-dev-bundler.js:161`），拿不到就 `process.exit(1)`。
   「先 Ready 后失败」是既定顺序，不是本仓配置错了。
2. **锁里的 pid 不是该杀的那个。** 那个 pid 属于 `next-server`（`ps` 里显示
   `next-server (v16.4.3)`）；杀它不释放锁。杀 `next dev` CLI 父进程实测 213 ms 干净退出、
   锁随之消失。选错目标，信号再强也没用。
3. **`--parallel` 没有 fail-fast。** 实测兄弟进程失败后等满 8 秒另一个仍在跑；`--no-orphans`
   只管父进程死后的子孙清理，不管这条。真实 worker 永不退出，所以终端会一直挂着。

## 决定

1. **`scripts/supervise.ts` 取代 `--parallel`。** `bun run dev` 与 `bun run start` 都走它：
   - 子进程输出加 `dev:web |` / `worker  |` 前缀（脚本名右补到等长再拼 ` | `）；
   - fail-fast：第一个子进程退出 → 其余收 SIGTERM，5 秒（`SHUTDOWN_GRACE_MS` 常量）后仍在的补
     SIGKILL，命令整体退出；
   - `SIGINT` / `SIGTERM` / `SIGHUP` 与「子进程先退出」走同一条 shutdown 路径，退出码分别
     `130` / `143` / `129`，子进程先退出时用它自己的退出码；
   - 运行态写 `tmp/supervise.json`：`{supervisor, startedAt, children: [{label, pid, script}]}`，
     `pid` 是子进程（**session leader**）的 pid；收尾按 **session 成员 + 进程树**枚举，不按进程组
     （`tmp/` 已 gitignore，不入库）。
2. **`scripts/dev-lock.ts` 做锁预检。** 起 dev 之前读 `service/.next/dev/lock`，分四种：
   `pid` 已经不活 → 删文件再起（删前看锁里的 port：本仓 next 仍在监听就只告警）；`pid` 活着、
   命令行像 Next **且** `cwd == realpath(service/)` → **不启动**，打印 pid / 进程名 / appUrl /
   `:4000` 状态 / 两条下一步，`exit 1`；命令行不像 Next（PID 复用）、像 Next 但 `cwd` 不是本仓库
   （另一个 checkout）、或文件读不出来 → 只告警、不删、照常启动。`cwd` 这一道是 F1 的核心：只看
   命令行子串会把别人的 `next-server` 当成自己的。
3. **`scripts/dev-stop.ts` 是唯一停机口。** `bun run dev:stop [--force]` 走三条路径：
   `tmp/supervise.json`（先 SIGTERM supervisor，再对 session 里仍属于本仓、命令行匹配的成员 +
   进程树补刀——`next-server` reparent 到 init 后只有 session 还认得它）→
   `service/.next/dev/lock`（锁 pid 先过归属证明，不过就只报告、不动；过了再看父进程：父进程是
   next-dev CLI 形态才 SIGTERM 父进程，否则 SIGTERM 锁 pid；父进程先退而锁 pid 还活着就再打一次）→ 端口（仅当锁不可读/缺失且 `:4000` 仍有监听：先证明监听者 `cwd == service/` 且命令行
   是本仓 dev 进程，才连它的 session 一起收；另外本仓已无 dev 进程且端口空闲时，读不出的锁也删）。
   SIGTERM 宽限 10 秒后 SIGKILL，`--force` 直接 SIGKILL；确认锁 pid 死了、**且锁里的 port 上没有
   本仓 next 在监听**，才删锁（flock 挂在 inode 上，CLI 逃出 session 仍可能握着同一个 inode）。

## 放弃的方案（否决）

- **按进程组收尾（第一版）。** 实测否决：`bun run --filter` 把真正的脚本放进**新的进程组**，
  `detached` 子进程自己带的那个组里只有 `bun run` 包装器 —— `kill(-child.pid)` 只打到包装器，
  `next dev` / `next-server` 原样活着。最终按 **session 成员 + 进程树**枚举：Linux 读
  `/proc/<pid>/stat` 的 session 字段，非 Linux 回退进程树。
- **`concurrently` / `npm-run-all`。** 为三十行的需求引一个依赖和一层 npm 语义；它的
  `--kill-others` 仍是单发 SIGTERM，也处理不了「父进程被 kill 后 `next-server` 以 PPID=1
  存活」这一条。真要用，还是得在外面再套一层收尸逻辑。
- **`bun run --parallel --no-exit-on-error`（或等它修）。** 方向反了：我们要的是**更快**收尾，
  不是容忍兄弟失败后继续挂着。等上游落地 fail-fast 才谈得上回退。
- **关掉 `experimental.lockDistDir`。** 锁挡住的是两个 dev 抢同一个 `.next/dev` 的脏写，那比报错
  难查得多。关掉等于把吵闹的错误换成安静的错误；而且这是 Next 的默认值，跟着默认走，升级时才
  不会被默认值反过来咬。
- **删 `service/.next/dev/lock` 解锁。** flock 挂在 inode 上：删掉文件名只是让新进程在一个新
  inode 上拿到锁，旧进程仍握着旧 inode —— 结果是两个 dev 同时写 `.next/dev`，正是锁要防的事。
- **在文档里教 `kill -9 <锁里的 pid>`。** pid 可能是子进程、也可能已被复用；`-9` 还让 Next
  来不及删锁文件。事故里普通 `kill` 三次无效，问题在选错目标而不是信号强度。

## 代价与重开条件

代价：

- 多三个脚本（`supervise` / `dev-stop` / `dev-lock`）要自己维护，跨平台细节归我们。
- `dev:stop` 依赖 `tmp/supervise.json`；状态文件被删时只剩锁与端口两条线索，而不持锁、也不占
  端口的 worker 收不到，只能手工找。
- 收尾靠 session：Linux 读 `/proc`，非 Linux 只能按进程树走；子进程若再自己 `setsid` 出去，就
  落回「杀 CLI 父进程」的手工兜底。
- 归属证明依赖 `cwd`：读不出来时（macOS 没 `lsof`、`hidepid`）退化为只看命令行，判断松一档；
  反过来一律不信，会让 `dev:stop` 在这些平台上变成 no-op。
- win32 上 supervisor 不 `detached`（没有 session 可枚举），收尾只能 `child.kill()` +
  `taskkill /PID <pid> /T /F`；判活仍是 `kill(pid, 0)`，锁清理逻辑不变。这条分支**未实测**
  （本机只有 Linux）。
- web 与 worker 同生共死的产品语义没变，只是从「bun 不管」变成「我们主动收」。

重开条件：

- Next 改成**先拿锁再 listen**，或把锁的失败提示改成指向 CLI 父进程 —— 那时 `dev-lock` 的预检
  可以退化成一条提示。
- `bun run --parallel` 落地 fail-fast（兄弟退出即杀其余），`supervise.ts` 就可以删。
- 目标平台只剩 win32 且不再需要 POSIX 语义 —— 直接换平台自带的任务管理器接口，别维护两套。

# 2026-10-27 dev 锁事故与 supervisor 落地

## 结果

`bun run dev` / `bun run start` 改走 `scripts/supervise.ts`（`dev:web |` / `worker  |` 前缀、
fail-fast：第一个子进程退出即 SIGTERM 其余、5 秒后补 SIGKILL、`SIGINT`/`SIGTERM`/`SIGHUP` 同一
收尾路径、`tmp/supervise.json`；**收尾单位是 session 成员 + 进程树，不是进程组**——
`bun run --filter` 把真正的脚本放进新进程组、但继承 session）；新增 `bun run dev:stop [--force]`，
三条路径（pidfile → 锁 → 端口兜底）收 web + worker 并清掉 `service/.next/dev/lock`；
`scripts/dev-lock.ts` 起 dev 前预检锁（陈旧就删，但删前看锁里的 port 上有没有本仓 next 在监听；
只有「`pid` 活着 + 命令行像 Next + `cwd` 是 `service/`」才算本仓库的 dev，才不启动、打印报告并
`exit 1`；别的 checkout 的 next-server、PID 复用、读不出的锁都只告警、不删、照常启动）。
`dev:stop` 对不属于本仓库的锁只报告不动（exit 0）；读不出的锁在「本仓无 dev 进程 + 端口空闲」时
才删。`docs/deployment.md`、`AGENTS.md`、`README.md` 三处口径
统一；deployment 里那句错的「任一子进程退出，另一个会被终止」已删。决策
`decisions/2026-10-27-dev-supervisor-and-lock.md`。

## 事故时间线（2026-10-27）

| 时间 | 事件 |
| --- | --- |
| 03:37 | 一个 `next-server` 起来，持 `service/.next/dev/lock`、占 4000 |
| 05:00 | 新的 `bun run dev`：绑 4000 → 打印 `Ready` → 拿锁失败 → `Another next dev server is already running.` → `exit 1` |
| 05:0x | 照 Next 提示 `kill <锁里的 pid>` 三次，锁始终没释放 |
| 05:1x | 杀 `next dev` CLI 父进程，213 ms 退出，锁随之释放 |
| 同期 | `bun run --parallel --no-orphans` 在 `dev:web` 死后不停 worker，终端卡死；实测等满 8 秒兄弟进程仍在跑 |

## 根因

- **锁是 Next 16.4.3 的默认行为**（`experimental.lockDistDir: true`，
  `next/dist/server/config-shared.js:287`），获取排在 `listen` 之后
  （`next/dist/server/lib/router-utils/setup-dev-bundler.js:161`），失败即 `exit 1`。
  「端口空着却说 already running」由此而来。
- **锁里的 pid 是 `next-server`，不是 CLI 父进程**；杀它不释放锁。
- **`--parallel` 没有 fail-fast**；`--no-orphans` 只清父进程死后的子孙，不管兄弟。

## 复现与排障命令

```bash
# 1. 锁在不在、里面是谁
cat service/.next/dev/lock            # {pid, port, hostname, appUrl, startedAt}
ps -o pid,ppid,etime,cmd -p "$(jq -r .pid service/.next/dev/lock)"

# 2. 端口是谁占的（与锁里的 pid 对照）
lsof -nP -iTCP:4000 -sTCP:LISTEN

# 3. 复现「先 Ready 后失败」：留一个 dev 在跑，再起第二个
bun run dev                            # 第二个进程：Ready → Another next dev server is already running. → exit 1

# 4. 正确收尾（不要 kill 锁里的 pid）
bun run dev:stop                       # SIGTERM，宽限 10s 后 SIGKILL，最后删锁
bun run dev:stop --force               # 直接 SIGKILL

# 5. 验证锁已释放
test -f service/.next/dev/lock && echo held || echo free
```

`kill` 根 `bun run dev` 之后 `next-server` 会以 PPID=1 存活、继续占 4000 —— 那正是 `dev:stop`
要处理的那一类孤儿，用 `lsof -nP -iTCP:4000` 能看见它。

## 验收记录

实测（本机 Linux、bun 1.4.2、2026-10-27；除注明外都跑在最终脚本上）：

- `bun test scripts/dev-lock.test.ts` → **16 pass / 0 fail / 63 expect**（F1 之后新增 5 条：别的
  checkout 的 `next-server` 判 `unknown`、命令行只是含 `next` 不算 dev、next-dev CLI 两种形态都算
  `running`、symlink 检出 realpath 相等、`cwd` 读不出来时退化为命令行）。
- supervisor 的前缀与 fail-fast（拿两个不碰端口、不碰库的脚本对拍）：
  `bun run scripts/supervise.ts manifest:check typecheck` → 输出 `manifest:check | ` 与
  `typecheck      | `（脚本名右补到等长）；`manifest:check` 退出码 0 后打印「停止 typecheck」，
  typecheck 收到 SIGTERM，supervisor 退出码 0；收尾后 `tmp/supervise.json` 已删。
- **收尾单位是 session 的证据。** 老后实测的链：`dev:web` 2315595 → `bun run --filter` 2315596
  （**新 pgrp**）→ `next dev` 2315597 → `next-server` 2315638（pgrp 2315596、**session
  2315595**）。我在最终脚本上看到的同一形态：`bun run --filter service dev` 2322623
  （pgrp 2322623）→ `next dev` 2322624 → `next-server` 2322665，session 同为 2322622。按
  `kill(-子进程 pid)` 只能打到包装器，所以最终按 session 成员 + 进程树收。
- **预检拒绝启动（现场）**：`:4000` 被另一个 dev 占着时起 `dev:web` → 打印「锁被另一个 Next dev
  进程持有 / pid 2322665 · next-server (v16.4.3) · appUrl · 启动于 … / `:4000` 有进程在监听 → 它
  正在服务 / 两条下一步」并 `exit 1`，没有 spawn 任何子进程。
- **真实一轮起停**（跑在收尾改成 session 之前的 05:16 版；锁路径与启动行为未变）：
  `bun run scripts/supervise.ts dev:web` → `✓ Ready in 385ms`，`service/.next/dev/lock` =
  `{"pid":2320236,"port":4000,...}`（锁 pid 是 next-server，不是 supervisor）；`bun run dev:stop`
  → 停 supervisor →「已删除 service/.next/dev/lock（pid 2320236 已退出）」→ `:4000 空闲` /
  `锁已清` / exit 0，无残留。
- `bun run dev:stop --force` → `--force` 透传（`$ bun run scripts/dev-stop.ts --force`），exit 0。
- `bun test service/test/workspace-scripts.test.ts` → **2 pass / 0 fail**（`dev`/`start` 指向
  `scripts/supervise.ts`、`dev:stop` 指向 `scripts/dev-stop.ts`）。
- **未测**：路径 ③（端口兜底）与「本仓无 dev 进程 + 端口空闲才删读不出的锁」只有代码与老后的
  验收，我这一侧没有现场；win32 分支也没有实机。

## 未做 / 已知限制

- `knowledge/index.md` 已追加本交接与决策两条链接；`plans/` 没有对应任务书，本轮不新增计划。
- win32 分支只有代码路径，没有实机验证。
- `dev:stop` 在状态文件被删时只剩锁与端口两条线索，不持锁也不占端口的 worker 收不到，得手工找。

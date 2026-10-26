# 可重试的同步失败不再烧版本号

Status: accepted
Date: 2026-10-26

> task-6 已落地（事务边界、写流、`bossPromise`、fs 码分类），本文按最终实现定稿。

## 背景

`needs_attention` 是终态 —— 不进审核队列、没有迁出路径、同版本重投仍是 conflict，代价是版本号
作废（见 `2026-10-26-single-extension-failure-isolation.md` 的「代价」第一条，这里不复述）。

而在这次改动之前，`syncRelease` 对「GitHub 回了一个 500」和「这个包的资产集确实坏了」给出的是
同一个结局：asset 循环里只有一个 `catch`，任何 `fetchAsset` 抛出都记成 `asset_failed` issue，
按不可归属处理，整条 tag 的每个版本 `needs_attention`。更糟的是错误被吞进 issue 之后 job 正常
返回，队列认为这次同步「成功」，连一次重试的机会都没有。一次网络抖动就烧掉整条 tag 的版本号。

判断标准也因此站不住：`fetchAsset` 抛错时，我们其实不知道「再试一次会不会得到不同答案」，但旧
实现一律当成「不会」。

## 决定

### 1. 失败按「再试一次会不会得到不同答案」分成两类

`AssetFetchError { retryable, status }`（`assets.ts:23-36`）把分类变成类型的一部分；调用方只允许
看 `retryable`，不允许看 message。

可重试（`isRetryableStatus`，`assets.ts:47-49`）：

- `401` —— 安装 token 在飞行中被拒，几乎总是时钟偏移或轮换期缓存，下次自然好。
- `408` —— 代理放弃了慢响应体。
- `429`、`5xx` —— GitHub 自己在说「再来一次」。

不可重试：其余 4xx。`404` 是资产不在了，`403` 是 App 丢了仓库权限 —— 下一次会读到同一个答案。

非 HTTP 的判定分两层。传输层在 `assets.ts`：网络错误、`AbortError`、空 body 一律可重试；`> 50 MiB`
不可重试，那是策略上限，重试还是同一个超大文件；长度与 `asset.size` 不符（截断）可重试，那正是
重试能修的东西。本地文件系统在 `sync.ts`：`isRetryableFailure`（`354-358`）在
`isRetryableAssetError` 之外，再看错误自带的 `code` 是否属于 `RETRYABLE_FS_CODES`
（`335-344`：`EIO` / `EMFILE` / `ENFILE` / `ENOSPC` / `EAGAIN` / `EBUSY` / `ETIMEDOUT` / `ENOENT`）。

`ENOENT` 进这张表值得单独说：走到解析时归档已经在本地磁盘上，而这个进程唯一读的文件就是它自己
刚写的那个 —— 不见了说明临时目录被外部清掉了，重试会重新下载，不是「这个包不存在」的判决。
坏 ZIP、非法清单仍然是永久错误：那是关于内容的结论，重试会读到同一份字节。

**无法命名的错误一律当可重试**（`assets.ts:76-78` 的 `classify` 兜底）：错判「永久」的代价是
版本号，错判「重试」的代价只是一次 attempt。

### 2. `classify` 必须同时映射 `GithubError`

`GithubAppClient.downloadAsset()` 自己就在 `client.ts:549/554` 抛 `GithubError`（带 status），
它不走 `downloadReleaseAsset` 的 `!response.ok` 分支（`assets.ts:161-166`）—— 那条分支只在别的
client 实现或测试替身下才可能命中。所以「改了 `assets.ts` 为什么还要动 `GithubError`」的答案是：
真正的状态码是从 `GithubError` 里出来的，不映射它，分类在真实链路上等于没生效。
`classify` 因此是三段：已是 `AssetFetchError` 原样返回；`GithubError` 用 `status` 走
`isRetryableStatus`；其余一律可重试（`assets.ts:68-79`）。

### 3. 可重试 → rethrow 交给队列，不可重试 → 照旧记 issue

asset 循环的 `catch` 第一句是 `if (isRetryableFailure(error)) throw error;`（`sync.ts:491`），
在写 issue 之前。`finally` 仍然清理临时文件（`505-507`），不会漏磁盘。

资产阶段的 abort 是干净的：版本行只在 group 循环里写（`518` 起），资产阶段抛错时一行都还没写，
所以重试从零开始。不可重试的失败继续走原来的路径：按错误自带的 `code` 记成 release 级 issue
（`494-504`，`asset_failed` 兜底）—— 所以 `sync_error` 里看到的可能是 `zip_*`、`manifest_*`，
也可能是不可重试的 fs 码（如 `EACCES`）。归属语义见隔离记录 §5。

### 4. 版本行与资产行在同一个事务里

group 循环里，一次版本写入被 `db.transaction`（`sync.ts:680-746`）包住，按序做三件事：

1. 插版本行（`681-702`，含 `detection_issue`）；
2. 写审核时间线（`recordModerationEvent(tx, …)`，`709` 或 `720`，取决于自动发布/重新进审）；
3. 逐平台插资产行（`729-743`，`onConflictDoNothing`）。

内存记账（`versionCount` / `assetCount` / `touchedProducts`）全部在提交后用事务返回值更新
（`748-751`），回调里不碰内存集合 —— 否则回滚了却已经把计数加上去。

**为什么必须包**：`existing` 分支（`624-645`）用「库里已存的资产集 vs 本次候选」判断是不是
`version_conflict`。如果版本行已经落库、资产行只写了一半就抛错，重试时那次比对会看到「同版本、
不同资产集」，把一次纯粹的写库失败读成「摘要被换了」，直接把版本降成 `needs_attention` —— 也就是
重试反而烧掉版本号。事务把「半写」这个状态从可能的世界里删掉了。`existing` 分支本身没动：它读的
是已完成提交的旧版本，不需要事务。

回归测试：`sync.test.ts:833`「rolls the version row back when the asset insert fails」用
`release_assets.size` 的 bigint 溢出在版本行与审核事件之后、资产行之前制造失败，断言版本行与
时间线都回滚，并断言重试是一次干净的插入、最终 `published`。

### 5. 薄壳负责记账，body 只管同步

`syncRelease` 现在是壳（`sync.ts:369-414`）：upsert `repo_releases` 为 `syncing` → 调
`syncReleaseBody` → 任何抛出都写 `sync_state = 'failed'` 与 `sync_error`，再原样抛给队列。

`sync_error` 的两种形状（`failureReason`，`sync.ts:318-325`，都截 500 字符）：

- `asset_fetch_failed (503): …` / `asset_fetch_failed (network): …` —— 资产阶段失败，带状态码或
  `network`。
- `sync_failed: …` —— 其它任何错误。

worker 捕获后把 delivery 标 `failed` 并重新抛出（`worker.ts:32-47`），pg-boss 这才开始重试。
重试成功后 delivery 标回 `processed` 且 `error` 清空（`deliveries.ts:35-48`；回归测试
`sync.test.ts:130`）。所以「失败留痕」落在 `repo_releases.sync_error` 与
`webhook_deliveries.error` 两列，不在 issue 日志里 —— 两列都会被成功的重试覆盖，这正是临时失败
应有的形状。

### 6. 重试参数

`queue.ts:28-34` 的 `WEBHOOK_QUEUE_OPTIONS`：

| 参数 | 值 | 作用 |
| --- | --- | --- |
| `retryLimit` | `5` | 5 次重试，加首次共 6 次尝试 |
| `retryDelay` | `60` | 首次等待 60 s |
| `retryBackoff` | `true` | 指数退避 |
| `retryDelayMax` | `600` | 单次等待封顶 10 分钟 |
| `expireInSeconds` | `1800` | 单次 job 的执行上限 30 分钟 |

实际等待由 pg-boss 12.38.0 的 `failJobsBody` 计算：`LEAST(retry_delay_max, GREATEST(retry_delay,1)
* (2^(n+1)/2 + 2^(n+1)/2 * random()))` —— 即每次落在 `[base, 2×base)` 并封顶。所以五段等待约为
60–120 / 120–240 / 240–480 / 480–600 / 480–600 秒，合计约 **23–34 分钟**，与 GitHub 5xx 窗口的
量级相符。

`expireInSeconds: 1800` 的依据：单个资产下载已被 `AbortSignal.timeout(90_000)` 钉死
（`client.ts:531`），一条 release 是「一个 checksums 文件 + 每平台一个 ZIP」，十平台 tag 最坏约
16.5 分钟纯传输，还没算解压、哈希与写库。pg-boss 默认 `expire_seconds = 900`（15 分钟）会把一个
仍在推进的 job 判过期，而过期走的是同一条 `failJobsBody`，于是它按重试处理、**从头重来**，把已经
下完的资产再下一遍。1800 s 给足余量，又能在 retention 之前收回真正卡死的 job。

不配无限重试：pg-boss 的 retention 是 14 天，一个真坏的 release 会在这期间被反复重跑，而队列里
积压的「重试中」还会掩盖真正的故障。

### 7. 三个坑，都写进代码注释了

1. **`create_queue()` 是 `ON CONFLICT DO NOTHING`**（pg-boss `dist/plans.js` 的
   `CREATE FUNCTION create_queue`）。只调 `createQueue(name, opts)` 的话，已经存在的部署永远保留
   旧配置 —— 新策略只对全新数据库生效。所以 `queue.ts:51` 紧跟一次 `updateQueue`，它走的是
   `UPDATE … SET retry_limit = COALESCE(…)`，才是真正改既有行的那条路。
2. **「不重试」不是默认值的现状**：pg-boss 默认 `retry_limit = 2`、`retry_delay = 0`、
   `retry_backoff = false`、`expire_seconds = 900`。以前错误从不冒泡，所以这些默认值从未生效；现在
   冒泡了，不显式配就会变成「0 延迟连试两次」—— 这才是必须写 `WEBHOOK_QUEUE_OPTIONS` 的真实原因，
   而不是「以前不重试、现在要重试」。
3. **失败的 `getBoss()` 不能被缓存**：`bossPromise` 原本只在成功路径上留值，一次失败（数据库没起来、
   `updateQueue` 抛错）会把 rejected promise 钉在模块里，之后每次 `enqueue` 都重放同一个拒绝，直到
   重启进程。现在 `.catch` 里先 `bossPromise = null` 再抛（`queue.ts:55-62`），下一次调用重新尝试。
   回归测试 `queue.test.ts:21`「a failed start is not cached」。

### 8. `repo_releases.sync_state` 状态机

| 值 | 谁写 | 能不能迁出 |
| --- | --- | --- |
| `pending` | 只有列默认（`schema.ts:671`），**代码从不写** | — |
| `syncing` | 壳的 upsert（`sync.ts:383` / `392`） | 被 body 的终态覆盖，或被壳的 catch 改成 `failed` |
| `synced` | body 收尾（`sync.ts:764`） | 下次同步的 upsert 改回 `syncing` |
| `needs_attention` | body 收尾（`764`）；`no_zip_assets`（`433`） | 下次同步的 upsert 改回 `syncing` |
| `failed` | 壳的 catch（`406`）；release 被删（`jobs.ts:193`，`sync_error = release_deleted`） | 下次同步的 upsert 改回 `syncing` |

**release 级没有终态**：任何一次成功同步都会覆盖上一次的 `failed` 或 `needs_attention`。终态只在
`release_versions.state` 上（`needs_attention`，见隔离记录）。所以「`repo_releases` 停在 `failed`」
既不等于版本已作废，也不等于有人会去处理它 —— 它只表示最后一次尝试的结果。

abort 时落在 `failed`，而不是 `syncing`：`syncing` 与「同步仍在进行」无法区分，也没有任何东西会
清扫它。

## 与既有决策的关系

这份记录**不推翻** `2026-10-26-single-extension-failure-isolation.md` 的隔离规则：归属规则、
`release_versions` 的爆炸半径、`releaseWide` 的回退行为全部不变。它只收窄「什么算检测问题」——
网络抖动、token 轮换、本机 fs 瞬时错误不再是检测问题，因此不再进入 issue 日志、不再触发 hold。
两份记录合起来是一条线：**先判断这是不是关于包的判决，再决定 hold 谁**。

## 放弃的方案

- **失败即写 `needs_attention` 等人工介入**：这就是旧行为。`needs_attention` 是终态，等于把一次
  503 记成「这个包的资产集有问题」，版本号作废；人工也无法把它迁出。
- **无限重试**：队列被一个坏 release 占住，retention 内反复重跑，且「一直在重试」会把真故障伪装
  成噪音。5 次 / 约半小时是一个能覆盖 GitHub 抖动的有限预算。
- **可重试失败也记一条 issue 留痕**：issue 的唯一消费者是版本裁决（`issuesHolding`），记了就会
  hold —— 等于换个地方烧版本号。留痕改由 `sync_error` 与 `webhook_deliveries.error` 承担，它们
  可被成功重试覆盖，才符合「这是临时失败」的语义。
- **在 `syncRelease` 内部原地循环重试**：占着 worker 槽，进程重启就丢，跨尝试没有持久状态；队列
  已经提供持久化重试与可见的 `failed` 计数，没必要自己再实现一遍。
- **把「版本行 + 资产行」的原子性交给重试去兜**：不行。重试的 `existing` 分支正是按资产集比对，
  半写行会被读成摘要变更，直接降成终态 —— 那等于用重试制造了它要避免的结果。

## 代价与重开条件

- **非原子窗口已由事务消除**：版本行、审核事件、资产行现在同生共死；写库中途失败只会留下
  `repo_releases.failed`，不留半份版本。代价是每个新版本多一次事务边界（一次 `BEGIN`/`COMMIT`），
  以及 `existing` 分支与事务分支的语义分叉需要维护者知道 —— 前者读旧行、后者写新行。
- **checksums 资产在循环外下载**：`loadChecksums`（`sync.ts:448`）在 asset 循环之前调
  `fetchAsset`，它抛错会直接 abort 整次同步 —— 包括不可重试的 404，也就是会白耗 5 次重试。这是
  **已知限制，不是遗漏**：三种可选结局里另两种都更差。① 把抓取失败记成 issue → `asset_failed`
  是 release 级，整条 tag 的版本号全烧，比白耗重试坏得多；② 抓不到就当成「这个 release 没有
  checksums 文件」继续跑 → 等于对一份**声明了自己带校验文件**的 release 跳过摘要交叉校验，拿
  完整性换可用性，方向反了；③ 现在这条：abort、`sync_state = failed`、重试耗尽后停。代价有界
  （5 次、约 30 分钟，不占版本号、不写版本行），而且这个 404 未必是终局 —— `loadChecksums` 用的是
  `release.assets` 里已列出的资产，404 更像 GitHub 侧的资产传播/缓存异常，重试有真实概率自愈。
  这条路径**不涉及临时目录泄漏**：`const downloaded = await fetchAsset(asset)` 在任何 `try` 之外
  （`sync.ts:149`），抛错时 `downloaded` 根本没有赋值，没有清理责任；`downloadReleaseAsset` 自己
  的失败分支已经删掉目录（`assets.ts:191-195`）。真正会泄漏的是写流打开失败那条，task-6 的 M1 已
  修：`pipeline` 在第一个字节之前就挂好监听并销毁所有流（`assets.ts:101-142`）。
- **`failed` 是可见噪音**：一次 GitHub 抖动会在 `repo_releases` 留一行 `failed`、在队列面板留一个
  失败 job，直到重试成功。运维需要知道这是暂时的，不要照着 `failed` 去改数据。
- **重试不续传**：每次重试重新下载整条 release 的全部资产，包括上一次已经下完的前几个。最坏情况
  6 次 × 十平台，带宽与时间是首轮的数倍。要续传就得引入临时文件跨 attempt 保留，与「不存包体、
  检测完即删」冲突。
- **永久性失败会停在 `failed`**：重试耗尽后 pg-boss 把 job 标终态，而 `repo_releases` 停在
  `failed`，没有版本行、也不会自动变成 `needs_attention`；目录里这个版本就是不存在的，直到新事件
  或人工重新同步。这是刻意的（宁可什么都不发，也不烧版本号），但「静默缺失」需要有人看队列面板。
- **`401` 归入可重试**：App 被撤权也会先重试 6 次才失败，代价是约半小时的延迟；换来的是 token
  轮换与时钟偏移的自愈。
- **导入路径不经过队列**：`importProductFromRepo` 直接 `await syncRelease`（`binding.ts:305`），
  可重试失败会抛成 500（`productErrorResponse` 对未知错误返回裸 500）。此时产品已建、仓库已绑，
  只是没有版本；用户再点一次导入会走 adopt 分支重来 —— 可恢复，但不是自动的。
- 重开条件：pg-boss 若改掉退避公式或默认值，参数语义要重算；GitHub 出现超过半小时的区域性故障
  时，要评估是否延长 `retryLimit` 或加 dead-letter 人工重放；导入路径的 500 若成为常见投诉，考虑
  给导入也排一次 job。

## 落地

`service/src/lib/github/sync.ts` 的行号是 **2026-10-26 收口时的快照（781 行）**；该文件仍在演进，
**以锚点为准**。

| 结论 | 锚点 | 行 |
| --- | --- | --- |
| 失败分类是类型的一部分 | `AssetFetchError`、`isRetryableStatus`、`isRetryableAssetError` | `assets.ts:23-54` |
| 可重试的 HTTP 码 | `status === 401 \|\| 408 \|\| 429 \|\| status >= 500` | `assets.ts:47-49` |
| 无法命名的错误当可重试 | `classify` 的兜底分支 | `assets.ts:76-78` |
| `GithubError` 必须一并映射 | `classify` 的 `instanceof GithubError` | `assets.ts:68-79`、`client.ts:549/554` |
| 可重试的 fs 码 | `RETRYABLE_FS_CODES`（含 `ENOENT`） | `sync.ts:335-344` |
| 统一的可重试判定 | `isRetryableFailure` | `sync.ts:354-358` |
| 可重试在 asset 循环里 rethrow | `if (isRetryableFailure(error)) throw error;` | `sync.ts:491` |
| 不可重试照旧记 issue | `catch` 里的 `recordIssue(..., null)` | `sync.ts:494-504` |
| 版本行 + 审核事件 + 资产行同一事务 | `db.transaction(...)` 三步 | `sync.ts:680-746` |
| 事务提交后才更新内存计数 | `written` 返回值 | `sync.ts:748-751` |
| 壳写 `failed` + `sync_error` 再抛 | `try/catch` + `failureReason` | `sync.ts:369-414`、`318-325` |
| 写流错误不再变成未捕获异常 | `pipeline` + `writeAssetBody` | `assets.ts:101-142` |
| 重试参数 | `WEBHOOK_QUEUE_OPTIONS` | `queue.ts:28-34` |
| 既有队列靠 `updateQueue` 才生效 | `createQueue` 后紧跟 `updateQueue` | `queue.ts:45-51` |
| 失败的 `getBoss()` 不缓存 | `.catch` 里 `bossPromise = null` | `queue.ts:55-62` |
| worker 重抛触发重试 | `markWebhookDelivery(..., "failed")` + `throw` | `worker.ts:32-47` |
| 重试成功清掉 delivery 的错误 | `error: error ?? null` | `deliveries.ts:35-48` |
| 状态机：`pending` 只有默认 | `sync_state` 列默认 | `schema.ts:671` |
| `failed` 的另一个写入者 | release 删除 | `jobs.ts:189-204` |

测试（`service/src/lib/github/sync.test.ts`）：`633`「aborts on a retryable failure instead of
burning the tag」断言 503 时行落 `failed`、`sync_error` 含 `asset_fetch_failed`/`503`、且一行
版本都没写；`671`「records a non-retryable failure instead of retrying it」断言 404 记
`asset_failed`、release `needs_attention`、幸存平台那版被 hold；`833`「rolls the version row back
when the asset insert fails」断言事务回滚且重试干净；`907`「aborts when the archive cannot be read
from local disk」断言 `ENOENT` 走重试而不是记 issue；`949`「separates transport and disk hiccups
from verdicts about the package」直接测 `isRetryableFailure`；`130`「a delivery that fails once and
then succeeds ends up processed」断言 delivery 从 `failed` 回到 `processed` 且 error 清空。另有
`assets.test.ts:10`「a destination that cannot be opened rejects instead of crashing the process」
与 `queue.test.ts:21`「a failed start is not cached」覆盖 M1 与 M4。

测试结果（Lead 实跑，最终树）：`bun run test` **804 pass / 0 fail（68 files）**、`typecheck` exit 0、
`manifest:conformance` 16 fixtures OK；四条修复都做了变异验证（改回去对应测试 fail）。

**未验证**：队列参数本身没有运行观测（需要真实 pg-boss 与 GitHub 故障注入），退避区间的依据是
pg-boss 12.38.0 `dist/plans.js` 的 `failJobsBody` SQL；`isRetryableStatus` 没有直接单测，只经由
`writeAssetBody` / `syncRelease` 间接覆盖。

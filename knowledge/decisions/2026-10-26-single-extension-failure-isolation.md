# 单扩展失败隔离：issue 按扩展归属，归属不了的才整条 tag 连坐

Status: accepted
Date: 2026-10-26

## 背景

计划 §10 Q3 定了数据形状（`repo_releases → release_versions → release_assets` 三层），并写下一句
语义要求：「一个 tag 挂 N 扩展：tag 级元数据只存一份，单扩展失败不污染同 tag 其它扩展」。

实现一直没跟上这句。`syncRelease` 里 issue 只有一条 release 级共享数组 `issues: SyncIssue[]`，
版本裁决写的是 `issues.length > 0`。三个后果：

1. **隔离失效**：A 包的 `digest_mismatch` 会把同 tag 的 B 包一起按 `needs_attention` 扣下。
   最典型的触发是「重编了某个平台、忘了刷新 `checksums.txt`」——一个摘要不符，整条 tag 的
   其它扩展全部进不了目录。
2. **裁决依赖处理顺序**：group 的遍历序＝asset 序（`groups` 是 Map，按首次插入）。旧逻辑下，
   先处理、且当时还没有任何 issue 的 group 能发出去；后处理的会被前面 group 的 issue 拖住。
   同一份 release 换一下 asset 顺序，谁被扣下就会变。
3. **两级状态被压成一级**：`repo_releases.sync_state`（整条 tag 的同步日志）与
   `release_versions.state`（单个扩展能不能上架）共用同一个「有没有 issue」的判断，于是
   release 级诊断和版本级裁决没法分开表达。

## 决定

### 1. issue 同时保留两种形状

`IssueLog { all, byExtension, releaseWide }`（`sync.ts:177-185`）。`all` 是全量平铺、按发现顺序，
仍然写进 `repo_releases.sync_error` 并作为返回值 —— 一次半成功的同步必须能从一行里查完，
分组不能以丢信息为代价。两个归属桶只决定 `release_versions.state` 的爆炸半径：

- `byExtension`：包内清单报了 id，只有那个扩展的版本行被 hold。
- `releaseWide`：issue 无法归属到任何扩展，本 release 里每个版本都被 hold。

`recordIssue(log, issue, extensionId)` 是唯一写入口（`188-201`）：`extensionId === null` 进
`releaseWide`，否则进 `byExtension[id]`。

### 2. 版本裁决只看「自己那组 + 不可归属那组」

`issuesHolding(log, id) = [...releaseWide, ...(byExtension.get(id) ?? [])]`（`204-206`），
裁决点是 `duplicatePlatform || issuesHolding(issueLog, extensionId).length > 0`（`670-673`）。

这样裁决与遍历顺序无关：asset 级 issue 在 group 循环之前就全部记完（`451-508` 先于 `518`），
group 级 issue 只会落在自己的 id 下（每个 id 只有一个 group），所以一个 group 的结论不会被
另一个 group 的处理先后影响。

### 3. 归属规则

| issue | 归属 | 代码 |
| --- | --- | --- |
| `manifest_mismatch` | 该扩展（该扩展本就不产出版本行） | `537-541` |
| `version_conflict` | 该扩展 | `639-643` |
| `repo_unknown` | 该扩展 | `567-573` |
| `repo_mismatch` / `repo_bind_pending` / `product_unclaimed` | 该扩展 | `122-126`、`584-588` |
| `platform_unknown` | `zip.manifest.id`（归档已经解析成功） | `474-480` |
| `digest_mismatch` | `claimedExtensionId(path)`；读不出 id 时退回 release 级 | `458-464`、`295-302` |
| **不可重试**的下载失败 / 归档解析失败（`asset_failed` 及 `zip_*`、`manifest_*` 等 code；可重试的下载失败不记 issue，见 §5） | release 级 | `486-505` |
| `duplicate_platform` | 不产生 issue，写进 `detection_issue`，天然按扩展 | `552-558`、`698-700` |
| `no_zip_assets` | 提前返回，没有版本行可连坐 | `429-446` |

「该扩展」那几个 claim 类 issue 有个共同点：那个 id 本来就不写版本行（分支里 `continue`），
归属它们的意义不在 hold 自己，而在**不连坐别人**。

### 4. 为什么读一个摘要不符的包是可接受的

`digest_mismatch` 是唯一需要「读一个我们已经拒绝的包」的地方，但它和另外两种解析前失败不同：
**下载成功了，字节已经在临时文件里，失败的是校验和比对**。所以清单读得出来，id 也就有了。

读它是可接受的，因为答案只被用在一件事上：决定 `needs_attention` 的爆炸半径。它不安装、不落库、
不进目录、不能促成发布；被拒的资产依旧被拒（`continue` 在 `464`）。一个在 id 上撒谎的包，最坏
结果是让同 release 里的兄弟被 hold —— 而「被 hold」不是「等一下就好」：`needs_attention` 是
终态（见「代价」第一条），兄弟这一版拿不到发布机会，版本号跟着作废，只能改清单 `version` 重发。
边界仍然锁在同一开发者、同一个 tag 内：`resolveProduct` 只对 `bound` 的产品写版本
（`523`、`560-589`），而绑库要求 installation 属于当前账号（`github/repos.ts:236`）。收益是
「A 的坏包不再拖住 B」这条主路径，但被限制在同一 tag 内的那个代价比「一条待办」重。

解析用的是**接受路径同一个 parser**（`readExtensionZip`，`21` 引入、`297` 与 `467` 共用），
不是更宽松的入口：安全条目名、清单必须在根、backend 入口必须存在，任一不满足就抛错，
调用方退回 release 级（`299-301` 的 `catch` 返回 `null`）。不给「读 id」开一条会绕过准入的旁路。

### 5. 为什么 `asset_failed` 是 release 级

先分清两类失败（2026-10-26 起，见 `2026-10-26-retryable-sync-failures.md`）：**可重试**的失败
（5xx、429、408、401、网络/超时/截断，以及 `EIO`/`ENOSPC`/`ENOENT` 这类本机 fs 瞬时错误）在 asset
循环里直接 rethrow，不记 issue、也不写版本行，整次同步交给队列重试；只有**不可重试**的失败才走到
这里。

落到 `asset_failed` 的是后者：下载已经确定失败（404 资产不在了、403 丢了权限、超过 50 MiB 的策略
上限），或者归档解析失败、字节不可信到连清单都读不出来 —— 前者没有可用的字节，后者有字节但不可信，
两种情况都没有 id 可归属。把这类 issue 塞给某个猜测的扩展，等于用假证据缩小爆炸半径。宁可整条 tag
假阳性，也不放行一个未校验的资产集。

这条也覆盖 `zip_*` / `manifest_*` 一类解析错误：`catch` 里优先取错误对象自带的 `code`，所以
`sync_error` 里看到的是具体原因，而不是一律 `asset_failed`。

### 6. release 行仍然记整条 tag

`repo_releases.sync_state` 仍是 `issueLog.all.length > 0 ? needs_attention : synced`，
`sync_error` 仍是整份 JSON（截 2000 字符，`761-772`）。即：**版本按扩展裁决，release 按整条
tag 记账**。分组只影响 `release_versions.state`，不影响 release 的同步日志。

**这条规律有一个例外，必须写出来**：`duplicate_platform` 不产生 issue，它只是一个布尔，写进
版本行的 `detection_issue`（`552-558`、`698-700`），不进 `all`。所以一条 release 里若只有重复
平台这一种问题，版本是 `needs_attention`，而 release 行可以是 `synced`。成立的是反方向：
**有 issue ⇒ release `needs_attention`**；不成立的是「release `synced` ⇒ 没有版本被 hold」。

## 放弃的方案

- **全部 `needs_attention`（保守做法）**：实现最简单，但与 §10 Q3 直接冲突。一次 arm64 摘要
  不符会让 monorepo 里完全无关的扩展停更；由于 `needs_attention` 是终态，被连坐的版本号只能
  作废、改清单版本号重发 —— 仓库越大，一次无关的坏包浪费的版本号越多。隔离正是 Q3 要的东西。
- **按文件名猜扩展 id**（`<id>-linux-amd64.zip` 之类）：文件名是开发者的自由文本，不是身份。
  猜错会把 hold 扣在无关扩展上 —— 比 release 级更糟，release 级至少是「这条 tag 有东西坏了」
  的真话；猜对也省不掉人工复核。归属只从包内清单读，读不出就不猜。
- **只留平铺日志、裁决时按 `detail` 匹配**：`detail` 是给人读的字符串（`asset.name`、
  `id@version`），不是稳定键，等于拿展示字段当外键。
- **摘要不符的资产直接丢弃、不记 issue**：最省事，但丢掉了「这条 tag 有坏资产」的唯一记录，
  `sync_error` 会显示 `synced`，等于把问题藏起来。

## 代价与重开条件

- **假阳性的账单是版本号作废，不是「等人工清」**：无法归属的失败（下载失败、坏 ZIP、摘要不符且
  清单也读不出）会让整条 tag 的每个版本 `needs_attention`，而 `needs_attention` 是**终态**：
  它不进审核队列（`moderation/queue.ts:38` 与 `moderation/store.ts:23` 的
  `REVIEWABLE_VERSION_STATES` 只有 `candidate|pending_review`），也没有任何迁出路径（发布只接
  `candidate|pending_review`，`store.ts:98/120`；拒绝只接 `pending_review`，`store.ts:143`；
  yank 只接 `published`，`products/service.ts:865`），版本行上唯一写它的是 `sync.ts:633`。修好
  checksums 再同步同一版本也救不回来：资产集变了走 `version_conflict`（`sync.ts:624-645`），
  仍是 `needs_attention` 且新资产不写入；资产没变则 `same` 分支直接 `continue`，状态不动。
  所以这些版本号**作废**，只能改清单 `version` 发补丁版本。保守默认依然成立，但理由要读成
  「宁可烧掉版本号，也不发未校验的包」，不是「反正有人会清」。
- **`digest_mismatch` 会多读一次 ZIP**：只在摘要不符时发生（正常路径零额外开销），且解析失败
  仍然退回 release 级 —— 不会因为「想拿 id」而放宽准入。
- **release 级与版本级会不一致**：一条 tag 里 B 正常发布、A 被 hold 时，`repo_releases.sync_state`
  仍是 `needs_attention`。这是有意的（tag 确实有问题），但任何「release synced 就等于全部发布」
  的推断都是错的；读「这个版本能不能装」必须看 `release_versions.state`。反方向的例外是
  `duplicate_platform`（release 可以 `synced` 而版本被 hold，见 §6）。
- **归属依赖清单 id 的诚实度**：撒谎的包可以把 hold 扣到同 release 的兄弟上，兄弟的版本号随之
  作废。边界仍在同一仓库、同一 release、同一开发者之内，且被拒的资产依旧被拒。
- 重开条件：若将来出现跨仓库或跨开发者共享一个 tag 的形态（当前不存在），`claimedExtensionId`
  的信任假设要重估；若「整条 tag 连坐」造成的版本号浪费成为常态，要改的是「不可归属时是否
  连坐」，而不是归属规则本身。

## 落地

`service/src/lib/github/sync.ts` 的行号是 **2026-10-26 收口时的快照（781 行）**。该文件仍在演进，
行号会漂移 —— **以锚点（符号 / 表达式）为准**，行号只用来当下跳转。

| 结论 | 锚点 | 行 |
| --- | --- | --- |
| issue 有两种形状：平铺日志 + 两个归属桶 | `type IssueLog`、`emptyIssueLog` | `177-185` |
| 唯一写入口，`extensionId === null` 进 release 级 | `recordIssue` 的 `null` 分支 | `188-201` |
| 版本裁决只看自己那组 + 不可归属那组 | `issuesHolding`、`duplicatePlatform \|\| issuesHolding(...)` | `204-206`、`670-673` |
| 摘要不符仍读清单拿 id；读不出退回 release 级 | `claimedExtensionId`、`digest_mismatch` 分支 | `295-302`、`458-464` |
| `platform_unknown` 用已解析的清单 id | 传给 `recordIssue` 的 `zip.manifest.id` | `474-480` |
| 下载/解析失败走 release 级，code 取错误对象 | `catch` 里 `recordIssue(..., null)` | `486-505`（`497-500`） |
| claim 类 issue 归属该扩展，不连坐兄弟 | `claimIssueCode`、`repo_unknown`、claim 分支 | `122-126`、`567-573`、`584-588` |
| `manifest_mismatch` / `version_conflict` 归属该扩展 | 两处 `recordIssue(..., extensionId)` | `537-541`、`639-643` |
| `duplicate_platform` 天然按扩展，且不进 `all` | `duplicatePlatform` 布尔 → `detectionIssue` | `552-558`、`698-700` |
| release 行仍按整条 tag 记账 | `syncState: issueLog.all.length > 0 …` | `761-772` |
| 返回值仍是平铺数组 | `issues: issueLog.all` | `778` |
| 无 ZIP 资产时提前返回 | `if (zipAssets.length === 0)` | `429-446` |
| `needs_attention` 是终态，无审核入口、无迁出路径 | `REVIEWABLE_VERSION_STATES`、三处状态写、版本行上唯一写 `needs_attention` 的 `.set` | `moderation/queue.ts:38`、`moderation/store.ts:23/98/120/143`、`products/service.ts:865`、`sync.ts:633` |

其余落地项：

- `service/src/lib/github/sync.ts`：`IssueLog` / `emptyIssueLog` / `recordIssue` / `issuesHolding`
  / `claimedExtensionId` 五个新构造，裁决点从 `issues.length > 0` 改为
  `duplicatePlatform || issuesHolding(...)`；`all` 继续喂 `sync_error` 与返回值。
- 测试 `service/src/lib/github/sync.test.ts` 的 `issue attribution` 组（`435` 起）三条：`446`
  「isolates a digest mismatch to the extension that shipped it」断言 A 的 arm64 摘要不符只 hold
  A、B 主题照常 `pending_review`，而 release 行仍 `needs_attention` 且 `sync_error` 含
  `digest_mismatch`；`515`「holds the whole tag when a broken asset cannot be attributed」断言
  两个坏包无法归属时无关的 D 也被 hold；`564`「does not let an unclaimed extension hold a bound
  one in the same tag」把未认领的包排在**前面**（group 序＝asset 序），断言 F 仍
  `pending_review` —— 这条正是旧实现会漏的那一侧。
- 测试结果由 Lead 在最终树上跑过（task-6 之后，含本记录的用例）：`bun run test`
  **804 pass / 0 fail**（68 files）、`bun run typecheck` exit 0、`bun run manifest:conformance`
  16 fixtures OK。31 个集成测试文件在 `beforeAll` 里把 `process.env.DATABASE_URL` 覆盖成
  `TEST_DATABASE_URL`，清的是测试库 `sforum_store_test`，dev 库不受影响。
- 对外可见行为不变：`SyncResult.issues` 仍是平铺数组（`778`），经 `products/binding.ts:343/354`
  与 `service/src/app/api/dashboard/repo-claims/[id]/claim/route.ts:60` 原样外传；仓内没有 UI
  消费这些 `code`（`claim-button.tsx` 只读 `product`/`created`），外部调用方是否读它**未验证**
  （验证方式：查部署侧 dashboard 客户端与运维日志）。

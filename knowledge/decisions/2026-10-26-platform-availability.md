# 架构可用性：`latestPlatforms` 与 `platform=strict|all`

Status: accepted（UI 与默认口径部分由 `2026-10-26-arch-auto-detect.md` 取代：目录恒
`platform=all`、不再有架构开关与平台下拉；`latestPlatforms`、`nil` vs `[]`、
`platform=strict|all` 契约、`compatibility` 求值仍然有效）
Date: 2026-10-26
Related: `2026-10-26-install-gate.md`（同一条「这一版还能不能装」判定链）、
`2026-10-26-catalog-card-dialog.md`（卡片/弹窗形态）、
兄弟仓 `SForum` 的对应决策记录 `2026-10-26-extension-executable-platform-gate.md`（宿主侧最终裁判）

## 背景

目录列表此前已经按宿主 `GOOS/GOARCH` 过滤（插件后端把 `runtime.GOOS/GOARCH` 作为
`os`/`arch` 发给商城，`buildSummary` 丢掉「没有任何版本支持该平台」的产品）。但：

- 详情弹窗返回**全部版本**，`defaultPlatform` 在找不到精确匹配时
  `return wildcard ?? release.platforms[0]` —— 会把异架构包递给宿主。
- 卡片只拿得到 `platforms`（所有候选版本的**并集**），无法表达「最新版跑不了、旧版可以」。
- 运营没有任何开关能看到「本机跑不了、但商城里有」的产品。

## 决定

### 1. `latestPlatforms` 与 `platforms` 是语义不同的两个字段

| 字段 | 取值来源 | 回答的问题 |
| --- | --- | --- |
| `platforms` | 全部候选版本的并集 | 「至少某一版能不能装」 |
| `latestPlatforms` | **卡片指向的那一版**（`latestVersion`）的发布资产 | 「最新这一版能不能装」 |

两者不一致**正是**「最新版不支持当前架构，但旧版可以」这个状态的唯一信息来源：客户端
据此选徽标文案，并决定弹窗默认选哪一版。

`latestPlatforms` 在契约里是**必填**（`ProductSummary.required`），因为省略它会让
客户端无法区分「没有这一版」和「服务端没实现」。

### 2. `nil` 与 `[]` 的语义必须分开

- `latestPlatforms: []` —— 这一版**没有任何发布资产**：那是「不知道」，不是「不支持」。
  客户端对空数组**不得**判为不可安装。
- `latestPlatforms` 字段**缺失** —— 旧服务端。客户端回落到 `platforms` 并集，
  同样不判死。
- `any/any` 是通配，匹配任何宿主。

实现上 `buildSummary` 用 `platformsOf(latestRow === null ? [] : [latestRow])`，
`latestRow` 为空时给空数组，**没有**拿 `platforms` 兜底 —— 拿并集兜底会把「不知道」
伪装成「支持最新版」。

### 3. `platform=strict|all` 只放宽可见性

- `strict`（默认，省略即此值）：列表只保留「至少有一个候选版本支持 `os`/`arch`」的产品。
  与既有行为**逐字节一致**，旧客户端不发这个参数时行为不变。
- `all`：架构维度不再藏产品，由客户端自己画「不支持当前架构」徽标。

**关键点：`all` 不改变 `compatibility` 的求值。** 一个只在别的平台上发布的产品在
`all` 口径下依旧报 `incompatible` —— 出现在列表里不等于商城改判成可安装。

### 4. `platform=all` 时 `compat` 只保留版本轴

这是实现里唯一一处「看起来在放宽、其实是必要的」改动：

`compat=compatible` 原本会同时用版本约束和平台约束求值。若 `platform=all` 下仍用
含平台轴的 `compatibility` 来过滤，那些刚被放出来的产品会立刻被 `compat` 又藏回去，
**开关等于没有效果**。所以 `platform=all` 时 `compatVerdict` 改用
`compatibilityOf(candidates, host, null, null)`，只判版本轴。

### 5. 服务端过滤必须保留

`platform=all` 不是「把过滤搬到客户端」：服务端仍要知道 `os`/`arch` 才能算
`compatibility`，而 `compatibility` 是安装门禁的输入之一。多一个只放宽列表的维度，
比「不传 os/arch」干净得多——后者会连兼容判定一起废掉。

### 6. 与 install-gate 的关系

同一条判定链上的两级：

| 层 | 判定 | 结果 |
| --- | --- | --- |
| `installGate`（页面） | `release.supported === false` | 禁用主按钮 + 说明（`platformUnsupported`，**平台判定先于版本判定**） |
| 宿主 Core（最终裁判） | 读制品文件头 | 安装 422 / 运行 409 `extension.platform_incompatible` |

页面永远只是「让你看见并选择」；能不能跑由 Core 说了算。

### 7. 旧服务端 / 旧宿主兼容

| 组合 | 结果 |
| --- | --- |
| 新商城 + 旧插件 | 旧 UI 可能递错包，Core 422 拦住 |
| 旧商城 + 新插件 | `latestPlatforms` 缺失 → 回落 `platforms` 并集；`platform` 参数不被识别，行为等同 strict |
| 旧宿主 + 新插件 | 宿主不报 `target` → 隐藏架构开关、保留旧回退（见下） |

**`defaultPlatform` 的边界**：`target` **已知**时无 exact/wildcard 即返回 `null`
（不再静默回退到 `platforms[0]`）；`target` **缺失**时保留
`wildcard ?? platforms[0]`。老商城/老宿主不发 `target`，删掉回退会把安装按钮凭空锁死。

## 附：本次事故的持久教训（DB 被清空）

`service/` 下 Bun 会自动加载 `.env.local`，其中 `DATABASE_URL` 指向 **dev 库**
`sforum_store`。一个一次性 dump 脚本在开头 `delete` 了产品表，第一轮插入失败，
但删除已生效 —— 目录数据（products / release_versions / release_assets /
repo_releases）归零，accounts / admin_accounts / store_settings / assets 仍在。

**规则**：一次性脚本必须**显式赋值**目标库，不要用 `??=` / 「没设才用默认」的写法。
`process.env.DATABASE_URL ??= ...` 这种模式在 Bun 里等于「默认连 dev 库」，一旦脚本
中途失败就会留下被清空的环境。

恢复证据（2026-10-26）：`0/0/0/0` → 删 `github_repos where repo_id=777001`（1→0）→
`bun run seed:dev` → `3/7/9/7` → 验收夹具插入并删除 → 回到 `3/7/9/7`。
详见 `../sessions/2026-10-26-platform-availability-handoff.md`。

## 不做

- 不改清单 schema（不要求作者声明 `backend.platforms`）。
- 不改公开商城站点。
- 不做卡片级安装按钮（卡片仍是整卡按钮）。
- 不自动停用已启用的错架构扩展。

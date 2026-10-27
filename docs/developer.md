# 开发者接入

把扩展发布到商城的完整流程。所有身份都来自你所在论坛的 SForum 账号——商城没有注册、没有密码。

## 1. 登录

1. 打开商城，点登录 → 跳转到论坛的 OAuth2 授权页 → 同意。
2. 商城按 `(issuer_key, sub)` 建账号；论坛换域名不影响归属。
3. 登出会同时撤销论坛侧 token。

## 2. 安装 GitHub App 并连接仓库

这是创建产品的**唯一**方式：`extension_id` 来自清单本身，不用手抄，也没有「先建产品再补仓库」的旁路。

1. 开发者门户 → 「从仓库导入」。
2. 还没有连接过 GitHub 时，选择器会给出「连接 GitHub」→ 跳转 GitHub App 安装页 → 选择仓库。
3. 回到选择器 →「从 GitHub 同步」把 App 可见的仓库拉到本地 → 选一个 → 「导入」。
   商城读取该仓库**最新 release** 里的 `sforum.extension.json`，用它的 `id` / `name` / `type`
   建产品、绑定仓库，并立刻同步这个 release。
4. 导入成功后，商城立刻读取该仓库的 README、`brand/icon.png` 与 `brand/social-preview.png`
   （缺失才回退社交预览）。任何一项失败都不影响导入，产品页的两个面板会显示失败原因与各自的
   刷新按钮。

商城只拿 `Contents: read` + `Metadata: read` + `Actions: read` 的 installation token，**不存 PAT**。

> 安装 App 只证明「这个安装覆盖了该仓库」，**不等于**「这个 GitHub 账号就是你」。
> 当前绑定强度记为 `installation`，界面上写「GitHub App 安装」而不是「已验证」。

`extension_id` 全局唯一（不是先到先得，冲突由审核裁决）；`slug` 由名称生成并自动去重。

**没有绑定仓库的 release 不会自动变成产品。** 清单里的 `extension_id` 若还没有对应产品，
它只会进「待认领的 release」（开发者门户首页的提示条 → `/dashboard/claims`），由该仓库所在
安装的持有者认领；已经属于别的仓库的产品不会被写入版本（`repo_mismatch`）。

## 3. 发布一个 release

1. 在仓库打 tag 并创建 release，附 **ZIP 资产**（`sforum.extension.json` 必须在 ZIP 根目录）。
2. 同步：由 GitHub webhook 即时触发。**目前没有「手动重同步某个 release」的入口**——
   选择器里的「从 GitHub 同步」只刷新仓库列表，不重跑 release。webhook 漏投时需要运维介入
   （见 `docs/deployment.md`）。
3. 商城逐包检测：清单 → 平台（`buildinfo` → ELF/Mach-O 头 → 文件名兜底）→ 流式 SHA-256；
   release 若带 `checksums.txt` / `SHA256SUMS` 会交叉校验，不一致即失败。
4. **一个 ZIP 只含一个扩展**。monorepo 多扩展 = 一个 tag 挂 N 个 ZIP，商城按 `extension_id`
   分组，每组内 `version/type` 必须一致。

### 版本语义

- 版本以 **manifest 的 `version`** 为准，release tag 只是标签；必须是严格 semver（三段数字，
  允许 `1.2.3-rc.1` 与 `1.2.3+build.5`，不接受 `1.2`、`v1.2.3`）。
- `sforumVersion` 是 **semver 约束**（Masterminds 语义），不是版本号；`>=1.0.0, !=1.2.3` 这类
  写法商城与宿主都能解析。
- 同一版本发布后**不接受新摘要**（包括新增平台）；要加平台请发补丁版本。摘要变化会被标
  `needs_attention` 并通知审核。
- `is_prerelease` 或 semver 预发布 → `channel=beta`。

### 清单契约

商城校验清单用的是**宿主自己的 JSON Schema**（`service/src/lib/detection/schema/manifest-v3.schema.json`
是 `apps/api/app/Support/ExtensionManifest/schemas/manifest-v3.schema.json` 的逐字节副本，
`bun run manifest:check` 校验摘要）。除此之外只补宿主必拒、商城必须知道的语义规则：

- **必填**：`manifestVersion: 3`、`id`、`name`、`description`、`url`、`author.name`、`version`、
  `type`、`sforumVersion`。`id` 是 2..81 字符的 `[a-z0-9][a-z0-9._-]*`，大写会被宿主 schema 拒绝。
- **backend**：声明 `entry` 时必须同时给 `rpc: "hashicorp-go-plugin"`、`protocolVersion: 2`、
  64 位十六进制 `digest`、`hostApiVersion`（形如 `sforum.host@2`）。
- **主题**不得声明 backend / permissions / capabilities / routes / hooks / events / jobs /
  providers / contributions / migrations / guards / schedules / content / editor / entities /
  database / cache / seo / services / commands / adminSurfaces / queries / queryResultFilters /
  identity / permissionDefinitions / media / lifecycle / openapi。
- **capabilities** 是字符串数组、不许重复；宿主按自己的目录判定，商城只原样展示（新增能力会触发复审）。
- **packageFiles** 若声明，商城会按清单里的 `path` + `digest` 逐文件核对；不一致直接判失败。
- **归档边界**：4096 个条目、解压后 50 MiB 上限；拒绝符号链接、重复条目与含 `..` 的路径。

清单里未通过上述检查的包不会进入目录：版本停在 `needs_attention`，审核页会显示具体错误码
（`manifest_*` / `theme_*` / `zip_*` / `package_file_*`）。

## 4. 审核

1. 产品首次上线必须人工审核：点「提交审核」（要求至少一个可审版本 + 默认语言文案）。
2. 审核员通过后，产品与其候选版本一起发布；此时写入审核快照（名称、仓库、能力集合）。
3. 之后的版本**自动发布**，只要满足：能力集合没有新增、产品没改名、仓库没换、快照存在。
   任一项变化，该版本回到「等审」队列，审核页会显示差异。
4. v1 不区分能力风险等级：**任何**未审过的能力键都会触发复审（保守口径，S6 之后可能放宽）。

审核只决定「是否发布」，不改变包内容；core 安装时的兼容性检查仍是最终裁判。

## 5. 图标与介绍：全部来自仓库

商城不再接受上传图片，也没有第二个「介绍」输入框。三样展示内容各有唯一来源：

| 展示项 | 来源 | 说明 |
| --- | --- | --- |
| 图标 | `brand/icon.png`，回退 GitHub 社交预览 | 与宿主品牌契约同一个文件；没有才用仓库 Settings → Social preview 那张 |
| 分享卡 | `brand/social-preview.png` | 目录卡片的封面背景 + 产品页的链接预览（Open Graph）；没有就退回分类色板、不发预览图 |
| 介绍 | 仓库 README | 服务端读取默认分支的 README，渲染后展示 |
| 摘要 | 你在门户里写（≤300 字） | 目录卡片与搜索结果用它；可从 README 首段一键填充 |

### README 规范

- 支持 Markdown（`.md` / `.markdown` / `.mdx`）；`.rst` / `.txt` 按纯文本展示。
- 相对图片（`./docs/a.png`）会被改写成
  `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`，由访问者的浏览器直接向 GitHub 取图。
  **私有仓库的图片对未登录访客不可见**（显示为破图与 alt 文本）。
- `http:` 图片降级成文字链接（混合内容会被浏览器拦掉）；`data:` 与 SVG 图片直接丢弃。
- 内联 HTML 只保留白名单标签（`details` / `summary` / `table` 等）；`script`、`style`、`on*`
  一律剥离，外链加 `nofollow noopener noreferrer ugc`。
- 标题会生成稳定的 `id` 与悬停才出现的 `#` 锚点，中文标题保留中文 id（`## 安装` → `#安装`），
  所以页面右侧的目录与 `#章节` 深链都能用。首个 `#` 会被压到 `h2`（页面自己已有一个 `h1`），
  其余层级原样保留。
- 代码块按语言名高亮，支持 `bash`/`sh`、`json`、`js`/`ts`/`tsx`、`go`、`yaml`/`yml`、`toml`、
  `diff`、`sql`、`css`、`html`/`xml`、`python`、`dockerfile`；未声明或未知的语言按纯文本展示，
  不做自动猜测。每个代码块都有语言标签与复制按钮。
- 表格会被包进可横向滚动的容器（键盘也能滚），窄屏不会撑破页面；图片可点击放大，
  但窄于 200px 的徽章不参与放大。
- 允许的 `class` 只有渲染器自己产出的那几类（`hljs-*`、`language-*`、`header-anchor`、
  `readme-table`、`readme-code`）；任意其它 `class`、内联 `style`、`id`（非标题）仍然被丢弃。
- README 改动**不需要发 release**：缓存 15 分钟后自动刷新，也可以在门户产品页点「重新拉取」。
- **README 不在审核范围内。** 审核只看摘要与清单；README 变更会写入审计，公开页也明确写
  「介绍来自仓库 README，由 GitHub 实时提供」。README 里不要放安装指令以外的承诺——它随时可改，
  商城不对其背书。

### 图标与分享卡

品牌资产按宿主契约放在**扩展包目录**里（与 `sforum.extension.json` 同级，见 SForum
`docs/extensions/brand-assets.md`）。商城读的是**仓库里的文件**，不是 GitHub 的社交预览设置：

```text
sforum-oauth2-provider/                 # 单包仓库：包就是仓库根
├── sforum.extension.json
└── brand/{icon.png,social-preview.png}

plugins/sforum-oauth2-provider/         # 多包/归档仓库：包在子目录里，品牌图跟着包走
├── sforum.extension.json
└── brand/{icon.png,social-preview.png}
```

商城怎么找到它：先看仓库根有没有 `sforum.extension.json`；没有就列一次仓库树，把所有含清单的目录
挑出来（最多 5 个），用清单里的 `id` 与产品比对，命中的那个目录就是包目录。只有一个候选时直接采用；
多个都对不上时不猜，面板会写「仓库里有多个扩展包目录，无法判断品牌图属于哪个」。

| 文件 | 契约（宿主校验） | 商城接受 | 用途 |
| --- | --- | --- | --- |
| `brand/icon.png` | 512×512 PNG，≤120 KiB | 任意**方形** PNG，≤1 MiB | 目录卡片、产品页页头、面板列表 |
| `brand/social-preview.png` | 1280×640 PNG，≤600 KiB | PNG，宽高比 2:1（±5%），≤1 MiB | 产品页链接预览 |
| `brand/icon.svg` | 512 viewBox 的自包含 SVG | 不读 | 只作为可编辑源文件 |

- 读取用 GitHub Contents API（安装令牌，**私有仓库同样可用**），`ref` 是默认分支的 HEAD：
  品牌描述的是产品，不是某个 release。
- 商城校验比宿主宽松（方形即可、1 MiB 上限），因为宿主已经用 `sforum extension brand check`
  把包闸住了；商城只需要一张画得出来的图。
- `brand/icon.png` 缺失或不合格 → 回退 GitHub 社交预览；两者都失败 → 卡片显示名称首字母。
- `brand/social-preview.png` 会铺在目录卡片的封面位（`object-cover`，152px 高）；它自带标题文字，
  所以卡片标题在封面上和下方各出现一次 —— 想要纯图封面就把标题从设计里去掉，或只留字标。
  **刷新失败不会把已有图标刷空**，门户的品牌图面板会写出原因（不是正方形 / 超过 1 MiB / 不是 PNG…）。
- 什么时候会自动更新：
  - **push 命中 `brand/`**（默认分支）→ 几秒内生效；
  - **发 release** → 同步完成后自动刷新；
  - **每天一次巡检** → 兜住漏掉的 webhook；
  - 门户产品页的「刷新品牌图」按钮 → 立即重读。
- 图片存为内容寻址资产，对外只发 `<商城>/api/assets/{sha256}`，不暴露 GitHub 地址；SVG 一律拒绝。

## 6. 撤回（yank）

- 门户 → 产品 → 版本 → 「撤回」并填写原因（1..500 字）。
- 立即生效：目录不再展示该版本，**已签发的下载链接立刻 410**。
- 撤回不删除历史；再上架要发新版本。整个产品下架由审核员执行（`delisted`），恢复需重新提交
  与审核。

## 6.1 下载链接可能要求登录

商城可以把「签发下载链接」改成需要商城账号（运营在后台「系统设置 → 下载登录要求」切换，
默认仍是匿名）。对你的产品没有额外要求，但如果你自己写脚本调 API，需要知道这三件事：

- `POST /api/v1/download-urls` 在 `account_required` 模式下没有有效令牌会回 **401**，稳定错误码：
  `login_required` / `token_expired` / `token_revoked` / `account_disabled` / `insufficient_scope`。
  令牌由 SForum 插件在「连接商城」授权后持有，脚本里拿不到，也不该去伪造。
- 浏览器入口 `GET /api/v1/products/{slug}/download/{os}/{arch}` 同样：未登录会 302 到论坛登录，
  登录后 303 回同一路径再 302 到签名地址。
- **签发是账号级，链接仍是 bearer**：拿到签名 URL 之后 30 分钟内谁都能下载，商城不会为每一次
  字节请求再验一次身份。所以「闸门」拦的是拿链接，不是字节——需要更强约束时用短 TTL 或撤回。

## 7. 发布前检查清单

- [ ] `sforum.extension.json` 通过 manifest v3 校验，`version` 是严格 semver。
- [ ] 清单在 ZIP 根目录，且带齐 `description` / `url` / `author.name`。
- [ ] 声明 backend 时四件套齐全（`rpc` / `protocolVersion` / `digest` / `hostApiVersion`）。
- [ ] 声明了 `packageFiles` 的话，路径与摘要和包内实际文件一致。
- [ ] ZIP 里只有一个扩展，`manifest.id` 与商城产品一致。
- [ ] 后端二进制与目标平台匹配（或主题 `any/any`）。
- [ ] `sforumVersion` 写的是约束（例如 `>=1.0.0 <2.0.0`），不是版本号。
- [ ] README 是 Markdown，相对图片路径正确（私有仓库的图对访客不可见）。
- [ ] 默认语言摘要已写（≤300 字，提交审核时不能为空）。
- [ ] 仓库里有 `brand/icon.png`（方形 PNG，≤1 MiB）与 `brand/social-preview.png`（2:1）——
      没有也能发布，但卡片会退回 GitHub 社交预览、分享卡会缺失。
- [ ] 能力（capabilities）只声明真正用到的；新增能力会触发复审。
- [ ] release 附 `checksums.txt`（可选，但商城会交叉校验）。

## 8. 常见问题

| 现象 | 原因 |
| --- | --- |
| 产品一直不出现 | 未发布 / 审核未通过 / 上游仓库 disconnected / 没有已发布版本 |
| 版本停在 `needs_attention` | 同版本换了摘要、平台重复、清单非法或 checksums 不匹配；看审核页的差异 |
| 提交审核报 `no_reviewable_version` | 还没有候选版本（先同步一个 release） |
| 提交审核报 `missing_copy` | 默认语言的摘要为空 |
| 图标是字母块 | `brand/icon.png` 与社交预览都没有抓到；门户产品页的「品牌图」面板会写出原因，点「刷新品牌图」重试 |
| 换了 `brand/icon.png` 但卡片没变 | 等 push 生效（几秒）、或发一个 release、或点「刷新品牌图」；App 没订 `push` 事件时只有后两者 |
| 图标还是旧的、面板说「不是正方形」 | `brand/icon.png` 宽高不一致，商城回退到社交预览；改成正方形再 push |
| 介绍是空的 | 仓库没有 README，或读取失败；门户产品页会显示失败原因，可点「重新拉取」 |
| 介绍不是最新的 | 缓存 15 分钟；点「重新拉取」立即生效 |
| 产品名改不了 | 名称取自扩展清单；改 `sforum.extension.json` 的 `name` 并发一个 release |
| 下载 410 | 版本被撤回、产品或仓库已下线；重新发布并取新链接 |

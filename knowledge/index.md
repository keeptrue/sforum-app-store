# Knowledge Index

## 当前状态

**实现阶段，S0–S6 已完成（本地验收）+ 2026-10-24 收尾轮 + 2026-10-25 产品身份单源化 +
2026-10-26 管理页三项（更新说明渲染 / 作者信息 / 安装门禁）+ 架构可用性（`latestPlatforms` / `platform=strict|all`）+
架构自动匹配（目录恒 `platform=all`、无架构选择、卡片给「支持 / 不支持当前架构」判决）。** `service/` 有 Next.js 骨架、
`contracts/store-api.yaml`、Postgres/Drizzle、OAuth2 登录/会话、GitHub App 客户端、
webhook/worker、release 同步/检测、DB 驱动的目录与详情、公开 `/api/v1`、签名下载代理、
产品 CRUD 与内容寻址图片、审核流（首个产品人工、后续按策略自动）、开发者门户与审核台、
四通道限流、认证审计；`plugin/plugins/sforum.store/` 是可安装插件（清单/Go 后端代理/预构建
ESM 管理页，zh-CN + en-US），宿主 validate+test+package 三闸全绿。

收尾轮（2026-10-24）修掉一处**会让真实登录必失败**的契约漂移：provider 的 token/revoke 路由
要求 `application/json`（表单编码被宿主以 422 `extensions.route_schema_invalid` 拒掉），
userinfo 是 camelCase。客户端与 fake provider 同时修正，并加了 `client_id` 8..128 的启动校验。
另关闭三项遗留：仪表盘列表 N+1、审核台 GitHub Actions 提示、插件管理页 en-US。

仍未验证：① 带登录会话的浏览器点击安装（宿主客户端只收 `https:`，服务端下载器写死公网
HTTPS）；② 完整真实 provider 登录（缺 client secret 与论坛用户会话）；③ 真实 GitHub App；
④ 安装门禁的**降级**分支（本机没有「已装版本高于商城任一版本」的产品，只有单测覆盖）。
详见 `sessions/2026-10-24-s7-provider-contract-and-optional-items.md`。

## Latest Handoff

`sessions/2026-10-26-arch-selection-removal-handoff.md` —— 商城不再提供架构选择：目录恒发
`platform=all`（产品不因异架构消失），删「只看支持当前架构」开关与安装条平台下拉；平台由
`defaultPlatform` 按宿主 `target` 自动决定（精确 → `any/any` → 第一项）。卡片新增正向判决
`支持当前架构`（顶掉原始平台 chip，清单进 `title`），`supportedAnywhere === false` 时抑制兼容
徽标；安装条空闲且可装时显示 `支持当前架构（linux/amd64）`。服务端/契约/Go 后端零改动。
证据：插件前端 **162 pass / 0 fail**、`build.sh` manifest OK（mjs 56,283 B / css 18,099 B，预算
81,920 / 20,480）、后端 `go vet`/`go test` 绿、宿主真机 `?channel=stable&platform=all` → 200，
卡片与安装条判决命中，桌面 1569×763 + 390×844 截图，移动端 footer 三行不溢出。决策
`decisions/2026-10-26-arch-auto-detect.md`。

其前：`sessions/2026-10-26-platform-availability-handoff.md` —— 架构可用性：`ProductSummary.latestPlatforms`
（卡片指向的那一版，与 `platforms` 并集语义不同；空数组=不知道、字段缺失=旧服务端回落）+
目录查询 `platform=strict|all`（默认 strict，`all` 只放宽可见性、版本轴仍生效，否则开关无效果）。
管理页新增 `platform.ts`/`foot.ts`、`installGate` 的 `platformUnsupported`（平台判定先于版本判定）、
卡片两种徽标、弹窗默认选最新可运行版本、平台下拉只留宿主/any、「只看支持当前架构」开关（默认开）。
证据：商城 **790 pass / 66 files**、typecheck 干净、`contract:generate` 无 diff、插件前端 **162 pass**、
后端 `go vet`/`go test` 绿、`build.sh` 摘要与三份产物逐项一致、宿主真机 1633×810 + 390×844
（strict=4 / all=5、`platform=bogus`→400、徽标/默认版本/禁用安装/下拉过滤全部命中）。
同批还恢复了一次 dev 库被一次性脚本清空的目录数据（`0/0/0/0` → `3/7/9/7`，见 handoff 的
「DB 事故与恢复」）。已知限制：旧服务端回落只有响应注入 + 单测、运行阶段 409 只有宿主单测、
平台下拉含 `any/any` 的真机样本缺。决策 `decisions/2026-10-26-platform-availability.md`
（该轮的架构开关与平台下拉已由 `decisions/2026-10-26-arch-auto-detect.md` 取代）。

其前：`sessions/2026-10-26-notes-author-gate-handoff.md` —— 商城管理页三项收口：更新说明改服务端渲染
（`ReleaseVersion.notesHtml`，复用 README 的渲染器与白名单，标题压到 `h4`、无 anchor、200 条内容
寻址 memo）、`ProductSummary.owner` 换成结构化 `author`（论坛账号 + 绑定仓库的 GitHub 账号，两半
独立，GitHub 链接由插件按白名单 `login` 重拼）、安装条加门禁（每版本 `installedRelation`
`newer|same|older|unknown`，同版本/降级/不可解析 → 只留一枚禁用主按钮，不提供卸载入口）、
作者条里的 `@用户名` 链到论坛个人主页（商城按 issuer 基址拼 `profileUrl`）。顺带补回宿主
preflight 清掉的清单项目符号，并把 `dist/*.css` 也改成构建产物（17,988 B / 预算 20,480）。证据：
商城 **784 pass / 66 files**、typecheck 干净、插件前端 **125 pass**、后端 `go vet`/`go test` 绿、
宿主四闸全绿、真机 1601×625 + 390×844 各一组截图。已知限制：降级态只有单测、staged 候选对宿主
清单不可见、表格滚动容器的 `aria-label` 仍是中文硬编码。决策
`decisions/2026-10-26-{release-notes-markdown,install-gate,product-author-surface}.md`。

其前：`sessions/2026-10-26-dev-compat-filter-handoff.md` —— 兼容过滤口径收口：dev 宿主默认
`compat=all`（不按版本过滤），其余有效宿主默认 `compatible`，显式 `compat` 始终优先；
`CatalogPage.compat` 作为可选字段回显本次实际生效的口径。预发布 core 的约束求值改成与 core
对齐：组级 `includePrerelease`（对应 Masterminds 的 `containsPre`）+ `major.minor.patch`
基线重试（对应 `CheckSForumVersion` 的 `releaseBase`），`!=` 两次都生效 —— 只做 baseline 重试
会漏 4 行「core 收、store 藏」。证据：Go 直跑 Masterminds v3.5.0 的 **420 行**判定矩阵
**0 mismatch**；`bun test` **770 pass / 0 fail / 2616 expect / 65 files**（此前 765/2，那 2 条是
`download/{issue,resolve}.test.ts` 泄漏 `STORE_PUBLIC_URL`，连 `getRuntimeConfig()` 的 15 s
模块级缓存一起修掉——只还原 env 仍会红），typecheck exit 0，`manifest:check` 摘要未变。
**已知限制**：公开站会原样转发访客手写的 `sforum`/`sforumBuild`，带参数时仍出逐卡「按开发版
估算」徽标（访客声明，不与插件页统一）；没报版本的老宿主仍走 `1.0.0` 兜底。计划口径已同步
（§7.3.8、§5.7、§7.3.9、§10.2 Q6 指针）。

其前：`sessions/2026-10-26-catalog-card-dialog-handoff.md` —— 商城管理页目录改版：一行一条 + 常驻右栏 →
卡片网格（列数用容器查询 1120/940/552 → 4/3/2/1；宿主侧栏可拖 14–22rem，视口断点会错判）+
挂 `document.body` 的三 Tab 弹窗（README / 版本信息 / 更新说明，底部 64px 安装条常驻；
`.sfstore` 的 `container-type` 会成为 fixed 后代的包含块，留在页面根会被裁）。安装语义未变
（成功仍是「已暂存」，启用/信任在 core，旧宿主走签名链接）。真机（1331×948）暴露并修掉六处：
primary hover 被通用 `:hover` 压成白底白字、宿主 `UModal` 无 z-index 被遮罩盖住、取消安装弹红色
Toast、确认框关闭后焦点无落点、3 列下徽标被压成省略号、compat 口径（新增 `auto`，显式
`compatible` 真的发出去）。`catalog.css` 20,403 B / 门禁 20,480（余 77 B）、`catalog.mjs` 47,066 B /
81,920，`bun test` 89 pass / 681 expect，清单摘要已更新（`f541286f…` / `3c1c9088…`）。
CDP harness 四档列数 4/3/2/1、`metaOverflow=0`、弹窗 1040/1040/960/390、高 713/713/780/844、
footer 桌面恒 65px；真机验证 hover、宿主确认框、取消后 `toastCount=0` 与焦点归还、Tab 双向回绕。
**未完成**：1633×810 与 390×844 两档真机截图（内置浏览器视口固定）；焦点陷阱在 Bun DOM 替身里
天然 no-op；远端封面图未做超时降级。决策 `decisions/2026-10-26-catalog-card-dialog.md`。

其前：`sessions/2026-10-25-store-menu-version-inventory.md` —— 插件从「一个 component 页」补成真正可运营的入口：
`admin.pages` 两页同 `group=应用商城`（商城 `/catalog` + 设置 `/settings`，后者由宿主 Schema UI 渲染，
`permission=extension.plugin.manage`），后台第一次能改商城地址；后端把 v2 握手拿到的
`coreVersion`/`buildVersion` 作为 `sforum`/`sforumBuild` 转发（`compat` 开关默认 `compatible`），
新增 `extensions.read` 读宿主已装清单产出「已安装/可更新」，`socialImageUrl` 进卡片封面，
四个闸（validate/test/brand check/package）全绿、73 条前端测试全绿。**未闭环**：本机 dev 库上插件路由
`admitted=false`（非 lifecycle V2 包换摘要后注册表不重发），补上 lifecycle V2 后启用卡在
`extension lifecycle registry publication exact fence conflict`，需要宿主侧复位后重跑真机链路。
决策 `decisions/2026-10-25-menu-version-and-inventory.md`。

其前：`sessions/2026-10-25-download-redirect-mode.md` —— 下载带宽不再是「要不要优化」，而是一个开关：
`STORE_DOWNLOAD_MODE=proxy|redirect`，默认 `proxy`（与之前逐字节一致）。`redirect` 且仓库公开时，
`/api/v1/download/{token}` 回 `302` 到 GitHub 已签好的对象地址，商城不再搬字节；私有仓库继续
代理（对象地址含仓库名与 tag）。取地址不取字节靠 `GithubAppClient.assetRedirectUrl`
（`redirect: "manual"` + 全部 `body.cancel()`），GitHub 直接 200 自吐字节时回落代理；302 带
`Referrer-Policy: no-referrer`。五项复核与双限流一行未改，yank 之后同一条短链仍然 410。
`DownloadTarget.repoPrivate` 来自 `github_repos.private`。契约新增 302 形态。**744 pass / 0 fail**、
typecheck 干净。未验证：宿主 `install-from-url` 是否跟随跨域 302（这是该模式的 go/no-go），
以及上游签名 URL 的 TTL（决定 yank 后的窗口长度）。决策
`decisions/2026-10-25-download-redirect-mode.md`。

其前：`sessions/2026-10-25-brand-assets-from-repo.md` —— 产品图标从「GitHub 社交预览」改为读仓库里的
`brand/icon.png`（宿主品牌契约的同一个文件），缺失或不合格才回退社交预览；`brand/social-preview.png`
成为产品页的 OG 分享卡。刷新有四条触发：绑定/导入、`release` webhook、`push` 命中 `(^|/)brand/`、
worker 每日巡检，外加门户里独立的「刷新品牌图」按钮（原按钮埋在「介绍」卡片里且静默吞掉图标失败）。
`push` 在写 `webhook_deliveries` 之前就被过滤，避免每次 push 存一份 payload。迁移
`0013_product_brand_assets`（9 列，纯加列）。**品牌图在包目录里**（`plugins/<name>/brand/`），
由清单 `id` 定位，不是仓库根 —— 第一版写死根路径导致真实仓库「文件在却说没有」，当日修复。
分享卡同时成为目录卡片封面（`ProductSummary.socialImageUrl`，契约已加）。
决策 `decisions/2026-10-25-brand-assets-from-repo.md`。

其前：`sessions/2026-10-25-compat-verdict-honesty.md` —— 目录里恒挂的「未校验」不再逐条盖戳：它本来就是
「这次渲染没拿到宿主版本」的回声（插件显式丢弃 `sforum`，前台访客也没有），占的却是产品名旁的
判决位。现在判词只在有判决时出现（`unknown` → `null`），页级一句说明，那个位置换成产品事实
——清单里的 `sforumVersion` 约束 chip（`ProductSummary.sforumVersion` 契约新增，插件
`catalog.response.json` 同步）。商品页版本行改写「未判定」。决策
`decisions/2026-10-25-compat-verdict-honesty.md`。708 pass / 46 pass / typecheck + 三个 check 全绿；
390 移动端与插件真机截图未取到（镜像窗口钉在 500px）。

其前：`sessions/2026-10-25-host-capability-catalog.md` —— 商品页与审核台的能力列表改为跟随 SForum 宿主
能力目录：13 条 key → 中文标签 / risk 等级 / 描述逐字 vendor（`lib/capabilities/`，lock 钉
commit `8662d07` + sha256，`capabilities:check` 进 CI），渲染期排序高→中→低→未知垫底，商品页加
聚合行与侧栏 chip、审核台每键标等级；未知键灰显「未收录」且不回填等级，两条限定文案写清
「等级≠插件质量」「宿主会推断追加」。自动发布闸门一行未改（`s4-review-flow` §4 仍有效）。
708 pass / 0 fail、typecheck 干净、`contract:generate` 无 diff；审核台真机截图待有管理员会话时补。

其前：`sessions/2026-10-25-readme-rendering.md` —— 产品页 README 从「被 preflight 削平的 HTML」变成有层级的
阅读面。两个独立原因叠在一起：① 浏览器拿到的是旧的 CSS chunk（dev 的 chunk 名固定 + Cloudflare
四小时缓存，`transferSize: 0`、86 条规则 vs 源码 118 条），② 渲染器把每个标题 +1 级，把最常见的
`###` 压到 `h4`=1em，与正文同大。渲染器改为 clamp（`h1→h2`，其余不动）、接
`markdown-it-anchor`（中文 id、`#` 锚点）与 `highlight.js`（class 输出，服务端跑——shiki 的内联
`style` 会被白名单拒绝）、表格包一层键盘可滚的容器；`.readme` 段整体重写（文档标题 1.55em / 章节
1.32em / `h3` 1.18em、语法 token 复用现有色相）；新增 `components/readme/`（复制按钮、`<dialog>`
灯箱、sticky 目录）与 `bun run readme:rerender` 回填（6 行 → 二次 0 变化）。卡片
`overflow-hidden` → `overflow-clip`，否则 sticky 目录永远不动（实测 `navTop: -3615` → `88`）。
全量 **679 pass / 0 fail**、`tsc` 干净；1633×810 与 390×844 实测（移动端用同源 iframe 复核，
本机 ego 浏览器不支持 device metrics 覆盖）。**未做**：生产构建（dev 占用 `.next`）、开发者面板与
审核台的登录后目视。缓存根因与自证命令写进 `docs/deployment.md`。

其前：`sessions/2026-10-25-dev-bun-turbopack-externals.md` —— `bun --bun next dev` 在 Next 16.4.3
（Turbopack）下必现全站 500：Turbopack dev 把 `serverExternalPackages`（`postcss`、`pg`）改写成
带哈希的别名 `require("<pkg>-<hash>")`，靠 `.next/dev/node_modules/<pkg>-<hash>` 软链解析，而软链
比 chunk 晚约 5 ms 落盘；Bun 把这次「没找到」缓存到进程生命周期（Node 不缓存），于是一次竞态就把
dev 进程永久毒化——`sanitize-html → postcss`（`/p/[slug]`）与 `pg`（`/api/health`）此后每个请求
都 500，`rm -rf .next` 后必现。`dev` 改为跑 Node（`"dev": "next dev -p 4000"`，`bun run` 不带
`--bun` 执行的就是 Node），build/start 保持 Bun 并已复测：`bun --bun next build` exit 0，
`next start` 下 `/api/health`、`/p/oauth2-provider`、`/`、`/api/v1/catalog` 全 200——生产在构建期
就写好 `.next/node_modules` 软链，没有那个竞态窗口。冷启动 dev 三页 200、日志零
`Failed to load external module`，`tsc` 干净。决策记录 `decisions/2026-10-25-dev-runtime-node.md`，
`AGENTS.md` §运行时闸门 已加这条 dev 例外。

其前：`sessions/2026-10-25-topbar-nav-progress.md` —— 三面共用外壳的顶栏底部加了一条 2px 路由进度线，
解决「点了但服务端还在渲染」与「点了没反应」在浏览器里长得一样的问题。App Router 没有导航事件，
所以起点有两个：文档捕获阶段的 click（`next/link` 自己在 onClick 里 `preventDefault`，冒泡阶段
读 `defaultPrevented` 永远为真，只能靠结构判断）+ 给 `router.push` 用的 `startNavProgress()`；
终点只有一个——`usePathname` + `useSearchParams` 变化。纯逻辑（`advanceProgress` 的指数爬升、
`shouldTrackClick`、相位状态机）在 `lib/nav-progress.ts`，DOM 与定时器在
`components/shell/nav-progress.tsx`。94% 封顶、100ms 显示延迟、1.2s 后改呼吸（动 `filter`
不动 `opacity`，否则淡出被动画压掉）、20s 看门狗、提交时只有跑过一格才补 100%。14 例单测 +
1633×810 / 390×844 实测时间线与截图（`tmp/nav-progress-*.png`）。**环境未清**：`tsc` 在
`lib/readme/render.ts` 有一个不属于本改动的错误（该文件本轮被并发修改），所以 `next build` 没跑；
全量测试 57 个失败是本地库缺 `product_screenshots`（迁移未跑）。

其前：`sessions/2026-10-25-github-app-manifest-flow.md` —— GitHub App 改成 **Manifest 一键注册**：后台
「0. 一键创建」把一份预配置 manifest POST 给 GitHub，操作者只需确认 App 名字，`id` / `slug` /
`pem` / `webhook_secret` 由 GitHub 直接交回服务端——手工路径的四个搬运点与三个静默坑
（slug 404、secret 401、少订 `repository`）一起消失，并顺手把文档漏掉的 **Public/Private 开关**
写成代码常量（Private 只有所有者能装，开发者装不到自己仓库上，绑定会直接死）。新增
`lib/github/manifest.ts`（纯协议层）、`POST /api/admin/github-app/manifest/start`、
`GET /api/github/manifest/callback`、`replaceGithubAppFromManifest()`（替换语义：删行级联删旧私钥，
审计 `removed`+`created` 两条）；state 绑管理员会话，因为 conversions 端点不认证、code 即凭据。
手动表单保留给 GHES 与接管已有 App。全量 **556 pass / 51 files**、`tsc` 干净、生产构建通过；
隧道域 1633×810 与 390×844 截图见 `/tmp/manifest-{pc,mobile}.png`；生产实例实测 start 路由 200，
浏览器实测「点击 → 表单 POST → GitHub 认出是 manifest 注册请求」。
**未验证**：GitHub 真的接受这份 manifest（要登录态的人点一次 Create）、GHES 端点、本地
`http://127.0.0.1` 当 `redirect_url`。环境改动两条：`service/.env.local` 追加
`STORE_DEV_ORIGINS=<隧道域>`（否则隧道下页面不 hydrate，按钮点了没反应）、dev 服务已重启并以
`nohup` 运行（日志 `/tmp/sforum-dev.log`）。决策记录
`decisions/2026-10-25-github-app-manifest-flow.md`。

其前：`sessions/2026-10-25-runtime-store-settings.md` —— 对外地址、下载短链有效期与六个限流通道离开
env 进库：单行 `store_settings`（迁移 `0010`），解析顺序「行 > env 种子」，`STORE_PUBLIC_URL`
仍启动必填但语义降为种子（`StoreConfig.publicUrl` 改名 `publicUrlSeed`，靠编译器找齐调用点）。
`getRuntimeConfig(db)` 15 秒进程内缓存 + 保存即失效，所以保存它的进程下一个请求生效、其它副本与
worker 15 秒收敛。后台入口 `/<adminPath>/settings/general`（侧栏「配置 → 系统设置」）显示生效
来源、三个派生地址（OAuth 回调 / GitHub webhook / Setup）、cookie 名与 6 行限流；API 是
`GET/PUT/DELETE /api/admin/settings`，带两个 409 闸门（`confirm_origin_change` /
`confirm_insecure_transition`）；`isSameOrigin` 改为「配置 origin 或请求 origin」双判据，
改地址不会把后台自己的写操作 403 掉；CLI `bun run settings:public-url -- --show|--set|--clear`
兜底。cookie 形状跟随生效地址的协议，http↔https 切换会让所有会话（含管理员）失效。`/api/health`
增 `publicUrlSource` / `settingsUpdatedAt` / `configWarning`。**未验证**：双进程 15 秒收敛、
真实反代下的地址切换、旧短链在旧域名停解析后的表现、后台两个闸门的浏览器交互。决策记录
`decisions/2026-10-25-runtime-store-settings.md`。

其前：`sessions/2026-10-25-tunnel-public-url-mismatch.md` —— 隧道/反代下「登录点了没反应」的根因是
`STORE_PUBLIC_URL` 仍是 `http://127.0.0.1:4000`：OAuth 回调、`errorRedirect`、`isSameOrigin`
基准、cookie 名与 `Secure`、下载短链全部从它推导，入口换了它没换就三处断（回调跨域读不到
state cookie、写操作 403 `origin_mismatch`、dev 下 `__nextjs*` 403）。落地：`lib/dev-origins.ts`
+ `STORE_DEV_ORIGINS` 让 dev 跨站放行可配置；`/api/health` 回报 `publicUrl`/`sessionCookie`/
`cookieSecure`/`nodeEnv`（缺配置给 `configError` 且仍 200）；`isSameOrigin` 拒绝时记
expected/actual；`useHydrated` 给三个页面级表单加提交门（未 hydrate 时原生 GET 会把密码写进
URL）；`docs/deployment.md` 新增「反向代理与隧道」小节。新增 14 条测试（4 文件 25 pass）、
`tsc` 干净、`next.config.ts` 可加载。**未验证**：新 `/api/health` 的运行时输出（4000 上是
改动前 03:37 的 `next start`，要 `bun run build` + 重启）、隧道域下 `/_next/static/*` 的实际
加载情况。

其前：`sessions/2026-10-25-admin-password-reset-command.md` —— 新增 `bun run admin:reset-password`
（根目录可用）：管理员密码重置的**可脚本化**形态，与交互式 `admin:password` 共用
`lib/admin/password-reset.ts` 的 `resetAdminPassword`（改哈希 → 清锁定/失败次数/
`must_change_password` → 删会话 → 写 `admin.password.reset_cli` 审计 → **写后回读校验**）。
密码来源三选一：TTY 隐藏输入 / `--password-stdin` / `--generate`（24 字符，stdout 只有密码，
便于 `PW=$(...)`）；另有 `--list`、`--json`、`--keep-sessions`，退出码 0/1/2/3。
`DATABASE_URL` 未导出时脚本自己读 `.env.local`。新增 11 条测试；全量 **469 pass / 44 files**、
`tsc` 干净，dev 库端到端跑通（临时账号已清理）。未验证：Node 回退运行时、重置后真实浏览器登录。

其前：`sessions/2026-10-25-github-app-config-in-console.md` —— GitHub App 配置离开 env 进库：五项
`GITHUB_APP_*` / `GITHUB_API_BASE_URL` 全部移除，凭据只在后台 `/<adminPath>/settings/github` 写，
存 `github_app_config` + `github_app_private_keys`（webhook secret 与私钥用 `STORE_SECRET_KEYS`
加密，界面只显示「有没有」与公钥指纹）。新增「验证」（`GET /app`，一次证明 app id + 私钥配对 +
slug 一致）、私钥先加后删的轮换、`github_config_unreadable` 与「未配置」分开表达；worker 不再因
未配置拒绝启动。全量 **458 pass / 43 files**、`tsc` 干净、生产构建通过；1633×810 与 390×844
截图见 `tmp/github-app-*.png`。未验证：真实 App 的 `GET /app`、双进程 15 s 窗口、真实 webhook
轮换、存量部署升级演练。决策记录 `decisions/2026-10-25-github-app-config-in-console.md`。

其前：`sessions/2026-10-25-github-repo-binding.md` —— 仓库绑定阶段 1：`syncRelease` 不再自动建产品、不再补
`repo_id`、不再跨仓库写版本；未认领的扩展 ID 进 `repo_claims` 队列，由安装覆盖的账号认领。
新增仓库选择器（本地镜像 + 显式「从 GitHub 同步」）、产品页 `RepoBindingPanel`、门户页
「从仓库导入」（从 release 清单取 id/name/kind 并立刻同步该 release）、`/dashboard/claims`。
7 个 dashboard 端点全走 `authorizeDashboardRequest`，绑定前必过 `findBindableRepo`（越权一律 404）。
全量 **430 pass / 42 files**、`tsc` 干净、生产构建通过；1633×810 与 390×844 截图见
`tmp/binding-{dashboard,product,picker,claims}-1633.png` 与 `tmp/binding-{product,panel}-390.png`。
未验证：真实 GitHub App 的 `getLatestRelease`/分页行为、阶段 2 的 OAuth 前提（见交接「未验证」）。
决策记录 `decisions/2026-10-25-github-repo-binding.md`。

其前：`sessions/2026-10-25-legacy-admin-role-and-seed-subjects.md` —— 首次 OAuth2 登录就看到「我的产品」和
可进的审核台：`seed:dev` 把演示账号写成 `(official, sub='1')`，与真实论坛用户的 `sub=1` 撞键，
登录 upsert 直接继承产品归属；同时 S1 遗留的 `store_roles.role='admin'` 行仍在放行审核台，与
`2026-10-25-admin-local-identity.md` 的承诺不符。现在 `CurrentSession.roles` 收窄成只认
`moderator`（类型级）、`getRoles` 在 SQL 与 TS 两层过滤 `admin`、两处 `MODERATOR_ROLES` 只留
`moderator`；`seed:dev` 的 sub 改为 `dev-1`/`dev-2` 与真实 subject 解耦。同一轮把侧栏「审核台」
入口也按角色过滤（布局读会话 → `ConsoleShell` → `ConsoleNav`），不再出现「看得见、点进去 404」。
全量 **375 pass / 38 files**、`tsc` 干净；dev 库已搬走演示产品归属并删除遗留 admin 行。

其前：`sessions/2026-10-25-issuer-single-source.md` —— OAuth2 收敛为单一登录来源：后台原本允许建任意多个
`active` issuer，但登录侧只在调用方自带 `?issuer=` 时工作、没有选择页、前台也不渲染 `?error=`，
多 issuer 等于把登录打死。现在「一个部署只有一个 active issuer」是三层不变量（部分唯一索引
`oauth_issuers_single_active_idx` + `assertNoOtherActiveIssuer` + 后台按钮禁用），`?issuer=` 降为
兼容参数，三种错误码在前台有可读提示；回调地址由 `lib/oauth/redirect.ts` 单一推导，并新增
`docs/oauth-setup.md` 与后台接入面板（SForum 建应用 8 步、权限勾选、失败码）。
全量 **374 pass / 38 files**（本会话实测）、`tsc` 干净、生产构建通过；1633×810 与 390×844 截图见
`tmp/{issuers,issuers-guide,issuer-dialog}-1633.png` 与 `tmp/{issuers,issuer-dialog,storefront-error}-390.png`。
注：同期 UI 统一会话报 **397 pass / 37 files**，两次计数差异未核对，以下一次全量为准。

其前：`sessions/2026-10-25-ui-unification.md` —— 三面 UI 统一：前台/开发者门户/审核台/管理员后台
挂同一个 `AppShell`（248px 轨 + 顶栏 + 移动端 Sheet），三态主题（浅色/深色/跟随系统）由外壳
统一渲染，`components/common/` 提供 `PageHeader`/`Section`/`Stat`/`EmptyState`/`Field`/
`SubmitButton`/`Modal`/`ConfirmDialog`，5 个表单对话框迁到 `Modal`，21 处卡片边框收敛到
`.surface`。全量 **397 pass / 37 files**、`tsc` 干净、生产构建通过；1633×810 与 390×844
（iframe 实测）截图齐全。未验证：OS 级系统主题联动（CDP 媒体模拟未落到页面）、插件管理页
主题、5 处 `window.confirm` 未换 ConfirmDialog。

其前：`sessions/2026-10-25-admin-console.md` —— 管理员后台 v1：本地管理员身份（`admin_accounts` +
`admin_sessions`，scrypt）、可配置路径 `STORE_ADMIN_PATH`（顶层动态段，改 env 重启即生效）、
一次性 setup token 注册首个管理员、OAuth2 issuer 全部后台可配（`STORE_BOOTSTRAP_ISSUER` /
`STORE_BOOTSTRAP_ADMINS` 删除）、六个模块（账号与角色、审计日志、全局产品、issuer 与 GitHub、
系统健康、发布策略只读）。全量 **350 pass / 35 files**、`tsc` 干净、生产构建与 7 个页面实测 200。

其前：`sessions/2026-10-25-brand-logo.md` —— 品牌资产统一：`SForum/apps/web/public/brand/sforum-logo.svg`
复制进 `service/public/brand/`，页面 logo 与浏览器标签页 icon 共用同一份文件（`BrandMark`
组件 + `metadata.icons` 同 URL），四个 shell 的字母砖全部替换，build + tsc + 1633/390 渲染
证据全绿。未做插件管理页 logo（宿主边界），未生成 PNG/ICO（工具链无栅格化器，且不引入 sharp）。

其前的交接见 `sessions/2026-10-24-ui-redesign.md` —— 前端视觉层全量重做：「签名管道」设计语言（深青
品牌色、Space Grotesk/JetBrains Mono 字体体系、深浅双主题、evidence 证据块）、删除 motion
入场动画修复目录白屏，storefront/dashboard/moderation 三个面视觉统一，build + 308 测试全绿。
其前的收尾轮见 `sessions/2026-10-24-s7-provider-contract-and-optional-items.md`（provider 契约
复核、`client_id` 启动校验、N+1、Actions 提示、管理页 en-US）。S0–S6 的交接已归档到
`sessions/archive/2026-10/`。

## 当前计划

| 计划 | 状态 |
| --- | --- |
| `plans/2026-10-25-host-capability-catalog.md` | **active（2026-10-25 交付，待人工验收）** —— 商品页与审核台跟随 SForum 宿主能力目录显示标签与 risk 等级（vendored 快照 13 条 + lock + `capabilities:check` 进 CI），只对齐展示，自动发布闸门不变；决策 `decisions/2026-10-25-host-capability-catalog.md` |
| `plans/2026-10-25-admin-console.md` | **active（2026-10-25 交付 v1，待人工验收转 completed）** —— 管理员本地身份 + 可配置后台路径 + setup token 注册 + OAuth2 后台配置 + 六个模块；决策记录 `decisions/2026-10-25-admin-local-identity.md`；交接 `sessions/2026-10-25-admin-console.md` |
| `plans/2026-10-24-app-store-service.md` | **active（S0–S6 完成 + 收尾轮，待人工确认转 completed）** —— 服务端与插件的完整设计；Q1–Q6 已裁决，六个阶段均已交付；收尾轮修掉 provider 契约漂移并关闭三项遗留；仅剩「真实登录 / 浏览器点击安装 / 真实 GitHub App」未验证 |

## 外部依赖（只读，不属于本仓）

| 依赖 | 位置 | 用途 |
| --- | --- | --- |
| SForum 安装交接 | SForum `knowledge/decisions/2026-10-24-admin-page-host-action.md`（落地 `10c2b21e8`） | 页面级宿主动作（`hostActions` + `bridge.installExtension`）的唯一来源；旧的「安装命令/意图表」设计已被否决 |
| SForum OAuth2 提供方 | 仓 `github.com/zhuchunshu/sforum-oauth2-provider` | 登录端点、CSRF、userinfo、scope |
| Manifest V3 schema | SForum `apps/api/app/Support/ExtensionManifest/schemas/manifest-v3.schema.json` | 清单校验：逐字节 vendor 到 `service/src/lib/detection/schema/`，`manifest-v3.lock.json` 钉 commit + sha256，`manifest:sync` / `manifest:check` 维护（见 `decisions/2026-10-25-manifest-contract-alignment.md`） |
| 宿主能力目录 | SForum `docs/extensions/catalogs/capabilities.md`（由 `go run ./cmd/sforum extension docs generate` 生成，源 `app/Support/Capabilities/catalog.go`） | 能力 key → 中文/英文标签、risk 等级、描述的**唯一**来源；商城只 vendor 展示副本（`plans/2026-10-25-host-capability-catalog.md`），不自己分级 |

## 关键约束速查

- **两条身份线**：论坛身份只来自 SForum OAuth2（账号键 `(issuer, sub)`）；管理员是商城本地账号
  （`admin_accounts`，scrypt 密码），互不授予。首个管理员凭 `STORE_ADMIN_SETUP_TOKEN` 注册。
- 后台路径 `STORE_ADMIN_PATH`（默认 `/admin`）是混淆不是防护；真正的边界是管理员会话。
- 全量 GitHub App；不存 PAT；不存包体；所有下载走签名短链。
- 仓库绑定是显式动作：sync 只写「产品已绑定该仓库」的那一种情形，未认领的 id 进
  `repo_claims`；`repo_bound_via` 只有 `installation`（弱）与 `github_identity`（阶段 2），
  界面不把前者写成「已验证」。
- 安装只经宿主的页面级动作（清单 `hostActions: ["extension.install"]` + `bridge.installExtension`），成功语义是**已暂存**；启用/信任在论坛后台完成。
- provider 的 token/revoke 请求体是 **JSON**；`client_id` 8..128、`code_verifier` ≥43。
- 一个 ZIP 只含一个扩展，清单必须在 ZIP 根；`sforumVersion` 是 semver 约束（含 `!=`）。
- 清单结构只认 vendored 宿主 schema；语义层只补宿主必拒的少量规则，`manifest:conformance`
  用同一批 fixture 与宿主校验器对拍。

详见 `../AGENTS.md` 与任务书 §2。

## 目录约定

- `plans/` —— 任务书。`draft` 期间不实施。
- `decisions/` —— 架构取舍；批准实施时创建首批两条。
- `sessions/` —— 热交接；旧的移入 `sessions/archive/YYYY-MM/`。
- `glossary.md` —— 术语，避免「产品/扩展/release」混用。

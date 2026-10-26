# GitHub 账号改名 `zhuchunshu` → `keeptrue`：哪些字符串该跟着变

Status: accepted
Date: 2026-10-26
Related: `2026-10-25-brand-assets-from-repo.md`（仓库标识出现在品牌图路径里）、
`2026-10-25-manifest-contract-alignment.md` 与 `2026-10-25-host-capability-catalog.md`（`*.lock.json` 的 `upstream`）

> **第二波（2026-10-26 22:03）**：(a1) 已翻转 —— 上游自己把 `apps/api/go.mod` 改成 `keeptrue`，
> 本仓随之上翻。上文「现状」与「重开条件」里「未提交 / 保持旧名」的说法已被文末
> 「第二波（当日）」一节取代；**判据没变，事实变了**。(a2)、(b) 不变，(c) 论坛用户名仍然不动。

## 背景

运营者的 GitHub 账号从 `zhuchunshu` 改名为 `keeptrue`。本仓与 SForum 上游的文本里，
`zhuchunshu` 出现在四类**互不相同**的位置上（另有两处要单独交代：生成物里的副本、容器镜像
命名空间）。它们字面一样、判据不同，按字符串批量替换会立刻踩坏其中两类。

实测（2026-10-26，本机经代理）：

```bash
# 旧账号的仓库 URL 仍是 301，跳去新名
$ curl -sI https://github.com/zhuchunshu/sforum-oauth2-provider | grep -i '^location'
location: https://github.com/keeptrue/sforum-oauth2-provider

$ curl -s -o /dev/null -w '%{http_code}\n' https://github.com/keeptrue/sforum-oauth2-provider
200

# 仓库名规范大小写是 SForum；大小写不参与 GitHub 身份
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://github.com/zhuchunshu/sforum
301 https://github.com/keeptrue/SForum

# raw 跟随改名，两条路径给出同一份文件；**已推送的 HEAD 里模块路径没变**
$ curl -s https://raw.githubusercontent.com/zhuchunshu/sforum/master/apps/api/go.mod | head -1
module github.com/zhuchunshu/sforum/apps/api
$ curl -s https://raw.githubusercontent.com/keeptrue/sforum/master/apps/api/go.mod | head -1
module github.com/zhuchunshu/sforum/apps/api
```

最后两行是这次改名的全部难点：**GitHub 的账号/仓库名变了，Go 的模块路径没变。**

### 现状（2026-10-26 当日）

> 本节是 22:0x 的快照，**已被文末「第二波」取代**：上游已提交并推送 `e753c72b0`，本仓已跟随。
> 下面「尚未提交」「继续按 `zhuchunshu` 消费」「CI 固定在 `26d8084`」都只描述那一刻，不是现行规则。

- 改名是**跨多仓批量**执行的（候选清单覆盖 `SForum`、`sforum-oauth2-provider`、`sforum-web-search`、
  `sforum-wiki-harvester`、`sforum-fetch-url`、`myapi`、`astudio2api` 与本仓），不是逐仓手改。
  本仓这次只负责统一**本仓可见的引用**与口径。
- **上游 SForum 的模块路径改名尚未提交。** 本机 `SForum` 检出里 `apps/api/go.mod` 的工作区首行已是
  `module github.com/keeptrue/sforum/apps/api`，但 `git show HEAD:apps/api/go.mod` 仍是
  `module github.com/zhuchunshu/sforum/apps/api`，`git status` 显示该文件未提交；远端（上面两条 raw
  请求）也还是旧名。
- 所以本仓**继续按 `zhuchunshu` 消费上游**，直到上游把这条改动提交并推送。这条约束是硬的，不是
  习惯：本地 SForum 工作区一改名，本仓后端立刻编不过（2026-10-26 实测）：

  ```bash
  $ cd plugin/plugins/sforum.store/backend && go vet ./...
  ../../../../../SForum/apps/api/sdk/plugin/v2/commands.go:12:2: no required module provides package
    github.com/keeptrue/sforum/apps/api/app/Support/ExtensionManifest; to add it: ...
  ```

  修法只有两个方向，且都等上游：上游提交并推送后，把 `require`/`replace`/import/`UPSTREAM`/lock
  整条链路一起改；或者本地把 SForum 工作区退回 HEAD（`git checkout -- apps/api/go.mod`），让工作区
  与远端一致。不要在本仓单方面改引用 —— 远端还没发版，改了就是解析失败。

  CI 不受影响：`.github/workflows/ci.yml` 把 SForum 固定在 `26d8084`（v3.0.18），该 commit 的
  module 行仍是旧名（实测），所以红只发生在「本机 SForum 工作区已改名」这个组合上。
  （**已被第二波取代**：pin 现在是 `e753c72b0`，见文末。）
- 在本仓，批量脚本没有落盘：`git diff` 与文件 mtime 都只反映本次任务自己的编辑，所以 `knowledge/`
  与 `AGENTS.md` 里剩下的旧名是**刻意保留**（(a1)/(c)/历史正文），不是漏改。

## 决定

### 判据：谁拥有这个标识符 + 有没有外部消费者

不按「看起来像不像 GitHub 名字」分类，按这两问：

| 类 | 标识符 | 谁拥有 | 外部消费者 | 处理 |
| --- | --- | --- | --- | --- |
| (a1) | `github.com/zhuchunshu/sforum/apps/api`（上游模块路径） | SForum 上游的 `go.mod` | 上游自己 + 本仓 `require`/`replace`/import | **改**（第二波已翻，见文末） |
| (a1 生成物) | `*.lock.json` 的 `upstream`、`sync-*.ts` 的 `UPSTREAM` | 上游模块路径的副本 | 本仓 `--check` 脚本 | **改**（跑 sync 重写，不手改；见文末） |
| (a2) | `github.com/zhuchunshu/sforum-app-store/...`（本仓自建模块） | 本仓 | 零（无 self-import、`go.sum` 0 条） | **改 `keeptrue`** |
| (b) | `https://github.com/zhuchunshu/<repo>`（仓库 URL） | GitHub 账号身份 | 人、浏览器、链接预览 | **改 `keeptrue`** |
| (c) | 论坛用户名 `zhuchunshu`（`@zhuchunshu`、`/u/zhuchunshu`、本地账号 `sub=1`） | 论坛自己的用户表 | 论坛前台路由 | **保持** |
| — | `ghcr.io/zhuchunshu/sforum-{web,api}` | 容器镜像命名空间 | 部署脚本 | 另计（见下） |

> 第二波已推翻本表 (a1) 与 (a1 生成物) 两行：上游 `e753c72b0` 改了 `apps/api/go.mod:1`，本仓已跟随
> （lock 的 `upstream` 由 `sync` 重写，不手改）。下表保留为第一波的判据记录。

### (a1) 上游模块路径：一个字节都不动

> 第二波已推翻本节：上游 `e753c72b0` 把 `apps/api/go.mod:1` 改成 `keeptrue`，本仓已跟随。本节保留为「当时为什么正确」的证据，不是现行规则。

`plugin/plugins/sforum.store/backend/go.mod` 的 `require github.com/zhuchunshu/sforum/apps/api v0.0.0`、
同文件的 `replace`、CI 里的 `go mod edit -replace`、所有 `.go` 文件的 import，全部保留旧名。
理由只有一条：**这条路径不由我们声明**。上游 `apps/api/go.mod` 的**已推送 HEAD** 首行仍是
`module github.com/zhuchunshu/sforum/apps/api`（实测见上；本地工作区已改名但未提交，见「现状」）。
两个方向的单方面改动都炸：本仓引用改新名而远端未发版 → 解析失败；上游本地工作区改名而未提交 →
本仓编不过（实测错误见「现状」）。

### (a2) 本仓自建模块：要改

`plugin/plugins/sforum.store/backend/go.mod:1` 的 module 从
`github.com/zhuchunshu/sforum-app-store/plugins/sforum.store/backend` 改为
`github.com/keeptrue/sforum-app-store/plugins/sforum.store/backend`。

判据是同一把尺子的另一半：**它由本仓拥有，且没有任何外部消费者** —— 仓内零 self-import
（`grep -rn github.com/zhuchunshu/sforum-app-store plugin/ --include=*.go --include=*.mod`
无命中）、`go.sum` 里 0 条 `zhuchunshu`、也不是被 `go get` 的发布模块。留着旧名等于让本仓
自称住在已非规范名的地址上。

代价不是「改一行」：module path 会嵌进二进制（`go version -m` 可见 `path`/`mod` 两行），
所以改完要重新构建并同步清单摘要（`bash plugin/scripts/build.sh` → `sync-digests.mjs` 重写
`backend.digest`）。本次已按此完成：二进制 sha256 `60e9a4e6…` 与清单 `backend.digest` 一致，
`go version -m` 报的是 `github.com/keeptrue/...`。

### (b) 仓库 URL：改

文档、决策记录、插件清单的 `author.url` / `url`、公开页链接，一律写 `keeptrue`。新文本不写旧名，
哪怕 301 现在还通 —— 跳转是 GitHub 的兼容行为，不是本仓的保证（旧名一旦被他人注册，跳转会指向
别人的仓库）。仓库名的规范大小写是 `SForum`，但 GitHub URL 的大小写不参与身份，所以文本沿用
既有的小写写法 `keeptrue/sforum`，不做无意义的大小写搬迁。

### (c) 论坛用户名：不动，而且最容易被误改

`accounts.username` 来自 SForum OAuth 的 userinfo，是**论坛自己的用户表**里的字段；本地测试账号
的 `sub` 是 `1`，用户名恰好也叫 `zhuchunshu`。它跟 GitHub 没有任何关系：改了它，等于替论坛改写
一个用户的身份，而商城正是靠 `(issuer_key, sub)` 认人的。
`decisions/2026-10-26-product-author-surface.md` 里「分不清显示名（`大佬`）还是登录名
（`zhuchunshu`）」举的就是这一类，**保持原样**。

### `*.lock.json` 的 `upstream` 为什么不能动

两个理由，第二个才是这次真正需要写下来的：

1. 它是 vendored 上游文档的**出处**，而上游模块路径没变（实测见上）。写 `keeptrue` 就是在
   lock 里记一个不成立的事实。
2. **改它不会让摘要更稳，只会让生成物与生成器分叉。** `capabilities:check` 的 `sha256` 只覆盖
   `catalog.json` 正文（`sha256(body) === lock.sha256`），`upstream` 只被要求非空；它的值来自
   生成器常量 —— `service/scripts/sync-capability-catalog.ts` 的 `UPSTREAM` 与
   `sync-manifest-schema.ts` 里的同一字段。手改 lock，下一次 `capabilities:sync` 就把它写回旧值，
   留下一条擦不掉的 diff。lock 是生成物：要改值就改生成器，而生成器的值本身是对的。

### 历史文档：不改正文，只加指路

- `knowledge/sessions/archive/**` 与热交接里的旧 (b) 类 URL **不改写**。交接是「当时发生了什么」
  的证据；改了就分不清事实与今天的约定。旧 URL 靠 GitHub 301 仍能打开（实测见上）。
- 热交接里仍在被照着操作的仓库名**只加一句括注**（
  `sessions/2026-10-25-brand-assets-from-repo.md`）：「该账号已改名 `keeptrue`，旧路径依赖
  GitHub 301 仍有效」—— 既不让人照着旧名去操作，也不篡改原句。
- 决策记录不是历史正文：`decisions/2026-10-25-brand-assets-from-repo.md` 里的仓库名直接改对。

### 镜像命名空间另计

归档里出现的 `ghcr.io/zhuchunshu/sforum-{web,api}` 是容器镜像路径，跟 GitHub login 走，属
**运行时依赖**而不是文本标识符。它是否随账号改名跳转，本次**未验证**：GHCR 对任意未授权的
`/v2/` 请求都回 401，探测给不出结论。由 ops 单独确认；文档里保留原样，不猜。

## 放弃的方案

- **全仓 `sed s/zhuchunshu/keeptrue/g`。** 会同时改坏 (a1)（上游模块路径，编译期直接炸）与
  (c)（论坛用户名，等于替用户改名），还会把历史交接改成「没发生过的事」。
- **把上游模块路径也改成 `keeptrue`。** 那要上游改 `go.mod` 并发版；本仓单方面改只会让
  `require`/`replace` 解析失败。这是跨仓变更，不由本仓推动。
- **手改 `*.lock.json` 换取「全仓没有旧名」。** 见上：改的是生成物，下次 sync 就打回，而它记的
  本来就是「上游仍叫旧名」这个事实。
- **重写归档与历史交接里的旧 URL。** 会让「当时照这个地址验证过」失去可追溯性，收益只是 grep
  干净。
- **新文档里两个名字都写。** 读者会以为有两个仓库、两个账号。

## 代价与重开条件

- **旧链接不是永久有效。** GitHub 的 301 只是兼容；旧用户名被他人注册后，历史文档里的链接会指向
  别人的仓库。这是「不改写历史」的代价，接受：新写的文本一律用新名。
- **本仓自建模块改名后，任何引用它的外部脚本或缓存路径会失效。** 已确认仓内零消费者；若将来把它
  发布成可 `go get` 的模块，(a2) 就变成「有外部消费者」，改名需要迁移窗口。
- **仓库身份不因此迁移。** 商城用 `repo_id` 认仓库，`full_name` 只是显示字段，`repository` 事件
  会刷新它；绑定、产品、版本数据都不需要动。
- 重开条件：上游 `apps/api/go.mod` 的 module 行改成 `keeptrue` **并已提交推送**（验证方式：
  `curl -s https://raw.githubusercontent.com/keeptrue/sforum/master/apps/api/go.mod | head -1`
  返回 `keeptrue`；只看本地工作区不算 —— 那就是现在这个未提交状态），
  此时 (a1) 整条链路（`require`/`replace`/import/`UPSTREAM`/lock）要一起改；或旧用户名被回收，
  历史链接需要逐个修。

## 第二波（当日 2026-10-26 22:03）：上游模块路径也已改名

第一波收工时 (a1) 还是「保持」。三小时后它失效了 —— **判据没变，是事实变了**：上游 SForum 自己
把 `apps/api/go.mod` 的 module 行改了，本仓只能跟。

### 触发证据

```bash
$ git -C ~/Code/github/SForum log -1 --format='%h %s'
e753c72b0 chore(repo): GitHub 账号改名 zhuchunshu → keeptrue        # 1,654 files changed

$ git -C ~/Code/github/SForum show 26d8084:apps/api/go.mod | head -1   # 第一波 CI pin 的 v3.0.18
module github.com/zhuchunshu/sforum/apps/api
$ head -1 ~/Code/github/SForum/apps/api/go.mod                         # e753c72b0
module github.com/keeptrue/sforum/apps/api

$ git -C ~/Code/github/SForum ls-remote --heads origin main
e753c72b0…	refs/heads/main
```

- 该提交**已推送**：`ls-remote` 与 `raw.githubusercontent.com/keeptrue/sforum/{main,master}/apps/api/go.mod`
  都返回 `keeptrue`，提交时间 22:03:03 与 `origin/main` reflog 的 `update by push` 对得上。
  所以**不存在「push 前 CI 必红」的时间窗**；真正的先后约束在 CI pin（见下）。
  （22:05 查时 `refs/heads/main` 就是 `e753c72b0`；之后 `origin/main` 前进到 `d1153068c`，而
  `e753c72b0` 是它的父提交。pin 仍指 `e753c72b0`，要的是「从这条起 `go.mod` 已是新名」这个性质，
  不是「最新」。）
- 上游自己也已按新名 import：`apps/api/sdk/plugin/v2/commands.go:12` 是
  `github.com/keeptrue/sforum/apps/api/app/Support/ExtensionManifest`。

### 为什么第一波当时正确、现在失效

判据是「**谁拥有这个标识符 + 有没有外部消费者**」。22:03 之前，`github.com/zhuchunshu/sforum/apps/api`
由上游 `go.mod` 声明、上游没改：本仓单方面改就是解析失败（第一波实测过反向：上游工作区一改名、
本仓没跟，`go vet` 直接报 `no required module provides package github.com/keeptrue/...`）。现在
拥有者自己换了名字，本仓从「消费旧名」变成「消费新名」—— 同一条判据，动作翻转。**规则没有被推翻，
是它依赖的事实被上游改写了。**

(a2)（本仓自建模块）与 (b)（仓库 URL）在第二波没有变化；(c) 论坛用户名 `zhuchunshu` 仍然一个字都
不动 —— 它属于论坛用户表，上游改 `apps/api` 的 module 行碰不到它。

### 一次假阴性：shallow clone 上的祖先判断

这次还踩出一个**工具层面的坑**，它和「判据没变、事实变了」是两种不同性质的教训，别混：

- **本地看到的是假阴性。** 本机 `~/Code/github/SForum` 是 shallow clone（`.git/shallow` 只有一行
  `8f0a66bebab693b8c463a6db0b3525d23a8e9c0d`）。在这个仓里
  `git merge-base --is-ancestor 26d8084 e753c72b0` 退出码 1（判「否」），
  `git rev-list --count 26d8084..e753c72b0` 只数出 3 —— 图的底部被截断了，结论不可信。
- **远端真值相反。** `gh api repos/keeptrue/SForum/compare/26d8084...e753c72b0` 返回
  `{"status":"ahead","ahead_by":9,"behind_by":0,"merge_base":"26d8084…"}`：**v3.0.18 是祖先**。
- **规则（可操作）**：跨 commit 的祖先/包含判断，只走远端 API（`gh api repos/OWNER/REPO/compare/A...B`，
  看 `status` / `merge_base_commit` / `ahead_by`），或先 `git fetch --deepen=<n>` 把历史补到能判定为止。
  **在 shallow 仓上，`git merge-base --is-ancestor` 与 `git rev-list --count` 不能作为证据。**
- **后果与订正**：这条错误事实曾写进 `.github/workflows/ci.yml` 的注释（「v3.0.18 is not an
  ancestor of this commit」），ops 已在 task-10 改成「v3.0.18 的 `go.mod` 仍声明旧名，落在同一段
  历史上不代表可用」。**结论没变**（pin 仍必须 ≥ `e753c72b0`），错的是理由 —— 这正是它危险的地方：
  一个对的结论配一个假的证据，下次换个场景就会推出错结论。
- 与「判据没变、事实变了」的区别：那是上游真的改了 `go.mod`（事实变了 → 动作翻转）；这是事实没变、
  工具在浅克隆上给了假证据（假象 → 换证据来源，不翻规则）。**前者改规则，后者改取证方式。**

### 连锁清单：必须同批移动

1. `plugin/plugins/sforum.store/backend/go.mod` 的 `require` 与 `replace`。
2. 后端 `.go` import（实测 19 处 `github.com/keeptrue/sforum/apps/api/...`）。
3. `.github/workflows/ci.yml` 的 `go mod edit -replace` 目标模块名。
4. 两个 `UPSTREAM` 常量：`service/scripts/sync-capability-catalog.ts`、`sync-manifest-schema.ts`。
5. 两份 lock 的 `upstream`（`catalog.lock.json`、`manifest-v3.lock.json`）—— 由 sync 重写，不手改。
6. `.github/workflows/ci.yml` 的 SForum checkout `ref`：`26d8084`（v3.0.18，module 行仍是旧名）
   → `e753c72b0` 或其后。

**pin 与引用必须同批**：pin 不动而引用先翻，CI checkout 到的是声明旧名的 commit，而 checked-in
的 `replace` 指向 `keeptrue`，两道都不满足，`go vet` 会在 CI 里复现第一波那个
`no required module provides package` 错误（推演：本地没有 CI 环境，未实测）。

第二波收尾时六处已全部落地（`ci.yml` 的 `ref` = `e753c72b0`、`go mod edit -replace` 目标 =
`keeptrue`），构建条件重新成立：本地 `go vet ./...` exit 0，`manifest:check` / `capabilities:check`
都 exit 0。这条顺序约束留在记录里，是为了下一次移动 pin 时别再踩 —— 顺序错了，红的是 CI，不是
代码。

### 可操作的一句话：lock 的 `upstream` 只能跟 sync 走

`capabilities:check` 的 `sha256` 只覆盖 `catalog.json` 正文、`upstream` 只校验非空，所以**手改
`upstream` 既不会让 check 变绿也不会变红**；而下一次 `capabilities:sync` 会按生成器常量把它写回去，
留下一条擦不掉的 diff。结论：**改 `upstream` 就重跑 `bun run capabilities:sync` / `manifest:sync`，
不要手改 lock。** 实测佐证：第二波开工时（22:0x）lock 里还是旧值，`capabilities:check` 照样 exit 0
—— **check 绿证明不了 `upstream` 是最新的**；sync 之后它才打印 `upstream e753c72`。

### 新的未决依赖与历史正文

- 上游已推送，唯一未决的是**本仓 CI pin 与本仓引用翻转的先后**（上一节）。可接受的时间窗：一个 PR
  内同批改完；不要用「把 `require` 退回旧名」换绿 —— 那会让本仓重新变成「上游已改名、我们还在消费
  旧名」，正是第一波禁止的形态。
- `plans/2026-10-24-app-store-service.md:138` 与 `plans/2026-10-25-host-capability-catalog.md:98` 里的
  旧名是**当时**任务书的记录，不改正文；以本节为准。
- 归档与热交接里的旧 (b) 类 URL 仍按第一波处理（GitHub 301），无需再动。


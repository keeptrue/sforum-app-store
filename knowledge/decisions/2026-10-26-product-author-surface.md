# 产品维护者：`owner` 字符串换成结构化的 `author`

Status: accepted
Date: 2026-10-26
Related: `2026-10-25-github-only-product-identity.md`（产品身份只来自 GitHub）

## 背景

`ProductSummary.owner` 是一个字符串：`accounts.display_name ?? accounts.username`。三个问题：

1. **它把两个概念压成一个值。** 消费端分不清拿到的是显示名（`大佬`）还是登录名
   （`zhuchunshu`），于是既不能当账号标识用，也没法在缺头像时回退。
2. **它只有一半。** 产品的另一半身份是**绑定仓库所属的 GitHub 账号**
   （`github_installations.account_login`）——那才是「这个包从哪来」。经营组织仓库时它甚至
   不是开发者本人，所以这一半必须单独表达、单独标注，不能拼进同一个名字里。
3. **插件只好把它丢掉。** 因为无法可靠解释，`sforum.store` 的映射层刻意丢弃 `owner`
   （`handlers_test.go` 还有一条「不得泄漏 owner」的断言），管理页因此没有作者信息。

## 决定

1. **契约新增 `Author`，`ProductSummary.owner` 删除。**

   ```yaml
   Author:
     username:    string | null   # accounts.username
     displayName: string | null   # accounts.display_name
     avatarUrl:   string | null   # accounts.avatar_url，仅 http(s)
     github:      { login, url } | null   # 绑定仓库的 installation 账号
   ```

   整体也可以是 `null`：两半都不存在时不画作者块。
2. **两半互相独立，缺哪半就不发哪半。** 不拿 GitHub 账号去填论坛账号的位置，也不反过来。
   查询侧在 `loadProductFacets` 多 join 一次 `github_installations`（按
   `github_repos.installation_id`），因此「有仓库没账号」「有账号没仓库」都能表达。
3. **GitHub 链接由插件用 `login` 重新拼，不信上游整串 URL。** `login` 过
   `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`（GitHub 自己的字符集），拼成
   `https://github.com/<login>`；不合格就丢掉这一半。理由：链接指向哪里不该由数据决定。
   头像同理，只放行绝对 `http(s)`，其余退字母块。
4. **文案写「GitHub 仓库账号」，不写「作者」。** 组织仓库属于组织，不是开发者本人；
   说「作者」是在替数据编造关系。
5. **作者条放在 README 分区最上方**，不动弹窗头部（84–106px 的几何）。打开弹窗默认就是
   README，第一个看到的是「谁发的这个包」，而头部仍然只放身份与安装状态。
   昵称后面的 `@登录名` 是**指向论坛个人主页的链接**，地址由商城按 issuer 基址拼成
   （`<base_url>/u/<username>`，`accounts.issuerKey → oauth_issuers.base_url`）后放在
   `author.profileUrl` 里：论坛前台路由归论坛所有，插件页面与后端都拿不到站点域名
   （`AdminPageBridgeV1` 不带 URL），让它们猜一个主机只会造出死链。缺用户名或缺 issuer
   配置时为 null，客户端渲染成纯文本。
6. **目录卡片不带作者。** 网格要保持可扫读；维护者是详情信息。
7. **商城自己的公开产品页同步改用 `author`**（`components/storefront/product-view.tsx`
   的「维护者」行与标题副行），`owner` 不再出现在任何响应里。

## 放弃的方案

- **保留 `owner` 并新增 `author`。** 两个字段表达同一件事，消费端一定会有一个用错；
  仓库契约是同仓同发布，不需要兼容窗口。
- **直接用清单里的 `author`（`manifest.author.name/url`）。** 那是**包声明的作者**
  （例如 `SForum` / `https://github.com/keeptrue/sforum`），与「这个产品是谁在维护」不是
  一回事。商城公开页把两者都列出来（`维护者` / `清单作者`），放进一个弹窗会变成两个「作者」。
- **作者条放弹窗头部。** 头部要多一行、窄屏（390px）下扩展 ID + 徽标 + 作者行会挤成两行，
  而且已安装 / 可更新徽标的判决位会被稀释。
- **头像走商城代理。** 头像是论坛自己的 `/media/avatars/...`，公开可访问；代理会引入
  论坛 → 商城的反向依赖。加载失败一律退字母块。

## 代价与重开条件

- **破坏性改名，无兼容期。** 旧插件（发 `owner`）配新商城会缺作者条，不会崩；新插件配旧商城
  同样只是缺这一块。
- **`author.github` 说的是仓库所有者，不是提交者。** 组织/多人仓库时信息有限；要表达「实际
  维护者」需要产品级的协作者概念（数据模型里没有），本轮不做。
- **跨域图片**：头像来自论坛域名，`img-src` 由宿主管理页的 CSP 决定；被拦时退字母块，
  不出现破图。
- 重开条件：产品需要多个维护者/协作者展示，或需要区分「仓库所有者」与「发布者」。

# 兼容性判词只在有判决时出现

日期：2026-10-25
状态：已实施
影响：`service/src/components/storefront/`（目录卡、商品页版本表）、`contracts/store-api.yaml`、
`plugin/plugins/sforum.store/`（Go 映射、管理页、`schemas/catalog.response.json`）、`docs/plugin.md`

## 问题

目录卡右下角那个「未校验」不是产品结论，而是「这次渲染没有拿到宿主版本」的回声，而且**必然是回声**：

- 插件后端只转发 5 个过滤参数，`sforum` / `sforumBuild` 显式丢弃（`backend/upstream.go`、
  `backend/handlers.go` 的 `catalogQueryFromRequest`），因为 SForum 侧 D9 暂不暴露 `coreVersion`；
- 前台是公开站点，普通访客的 URL 里不会有这两个参数；能带的只有手工改 URL。

于是：

1. **零信息**：8 张卡同时挂同一个灰点，占的却是产品名与平台之间的判决位。
2. **语义误读**：「未校验」紧贴产品名，被读成「这个插件没校验过 / 没过审」，与真正的生命周期词
   （审核中 / 已发布 / 已下架）撞车；`AGENTS.md` 禁止写「已验证构建」，它的反义词同样在制造暗示。
3. **文案泄漏实现且只对鼠标可见**：hint 是「请求未携带宿主版本」，且只挂在 `title` 上。
4. **两处结构性偏差**：`describeCompatibility` 的 `incompatible` 分支不可达（`pageCompatibility`
   只会返回 `unknown` 或 `compatible`）；商品页版本行的「未校验」是硬编码字面量，而
   `loadProductDetail` 本身支持宿主版本入参，一旦页面开始传就会撒谎。
5. 插件侧最糟：每行一个「未校验」，页面上没有一句解释。

## 决策

**判词是「关于宿主」的断言，只有真的算了才写；没有宿主版本时，页级说一次，行内不说。**

1. `badgeForCompatibility` 对 `unknown` 返回 `null`：卡片、插件目录行都不渲染判词；`compatible` /
   `incompatible` / `estimated` 三个分支保留，D9 放开后自动恢复成真判决。
2. 页级一句 `describeCompatibility`（前台）与 `compatibilityNote`（插件）说清「为什么本页不判」；
   删掉不可达的 `incompatible` 分支。
3. 卡片/行的那个位置改放**产品事实**：最新版本清单里的 `sforumVersion` 约束（`sforum >=1.4.0 <2.0.0`）。
   它正是 core 安装时求值的那条字符串，商城不需要替它下结论。为此 `ProductSummary` 新增必填
   `sforumVersion`（不可解析时为空串），插件 `catalog.response.json` 同步新增并原样透出。
4. 商品页版本行改用共享常量 `UNJUDGED_LABEL`（「未判定」），不再硬编码。

## 代价与取舍

- 卡片多一个 chip：换来的是「可核对的事实」而不是「恒定的灰色判决」。约束过长时截断到 18 字符，
  `title` 保留全值；运算符不做改写（`>=` 不变成 `≥`），否则与详情页会出现两种表示。
- 契约新增必填字段：旧插件读到缺失值经 `stringOr` 兜底为空串，只是不显示 chip，不会崩；
  旧服务对新插件同理。
- 插件需要重建 `dist/` 与摘要（`bash plugin/scripts/build.sh`）。

## 不改变的边界

商城仍然**不是**兼容性的最终裁判：过滤逻辑（`buildSummary` 里 `compat=compatible` 的剔除）一行未动，
`unknown` 仍然不过滤。本次只改呈现与一句话的措辞。

## 重开条件

SForum 暴露 `coreVersion`（D9 变更）后，插件后端转发 `sforum` / `sforumBuild`，判词变成真判决；
那时卡片与行内的 `兼容` / `不兼容` / `按开发版估算` 分支（已保留）会重新出现，页级说明改为
`compatFilteredNote`。访客自行声明版本（前台 `?sforum=` 控件 + `compat` 开关）是另一条可选路径，
本次未做：前台没有会话级版本概念，先加控件会把「一次声明」误当成宿主事实。

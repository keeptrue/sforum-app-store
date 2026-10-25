# 审核流：双轴状态、自动发布策略与“重新进审”的边界

Status: accepted
Date: 2026-10-24

## 背景

S4 要回答三个互不独立的问题：产品什么时候能上线、一个新 release 什么时候可以不经过人、
“改名 / 换仓 / 新能力”到底重审什么。计划 D8 只给了方向（“首个产品/首个 release 人工，
后续自动；改名、换仓、新增高危能力重新进审”），没有说清“重新进审”是下架重审还是拦在
发布边界上。这决定数据模型、开发者体验和安装可用性，必须先钉住。

## 决定

### 1. 两条轴，各自推进

- **产品轴** `products.status`：`draft → pending_review → published | rejected`，
  `published → delisted`。它回答“这个产品是否对外可见”。
- **版本轴** `release_versions.state`：`candidate → pending_review → published | rejected`，
  `published → yanked`。它回答“这个包能不能被安装”。

目录可见性只看产品轴 + 上游连通性 + 至少一个 published 版本（§5.3），审核不新增可见性条件。

### 2. 首次人工，之后按“变更集”自动

`decideReleaseState`（`service/src/lib/moderation/policy.ts`）在同步时决定版本状态：

- 产品不是 `published` → `pending_review`（首审）；
- 产品 `published` 且满足全部不变量 → `published`；
- 否则 → `pending_review`，并写 `moderation_events(action=re_review_required)`（actor 为 null）。

不变量（全部来自批准时写入的快照）：

- 版本声明的能力集合 ⊆ `products.capabilities_reviewed`；
- 当前展示名（`product_translations.name`，回退 `products.name`）=== `name_at_review`；
- `repo_id` === `repo_id_reviewed`；
- 快照存在（null 视为“未审过”，保守拦下）。

### 3. “重新进审”拦在发布边界，不把已上线产品拉下架

改名或换仓之后：

- 已发布的旧版本继续可见、可装（不制造竞态：正在安装的用户不该因为一次改名拿到 410）；
- **下一个新版本**停在 `pending_review`，审核页展示 `productRenamed` / 能力差异；
- 审核员批准该版本时刷新快照（`name_at_review`、`repo_id_reviewed`、能力并集），改名即被
  “接受”。

代价：改名后的展示名在批准前就已经对外可见（目录显示新名字）。这是刻意选择——把文案改动
做成“立刻下架”会让一次错别字修复停服。若将来需要“展示名也要审”，做法是给展示名单独一条
待审记录，而不是复用 product.status。

### 4. 能力不区分风险等级（v1）

“新增高危能力重新进审”在 v1 落成**任何未审过的能力键都重新进审**。理由：权限/能力目录尚未
定稿（§10.3、S5/S6），先编一套风险分级会把未验证的判断写进发布闸门。代价是 `settings.own`
这类低风险能力也会触发一轮人工；S6 定稿能力目录后再按风险分级放宽。

> 2026-10-25 更新：宿主目录已定稿，**展示层**分级落地（标签 + 等级，见
> `decisions/2026-10-25-host-capability-catalog.md`）。本条对**发布闸门**依然有效：
> 任何未审过的键都重新进审，等级只影响审核台的阅读顺序与徽标颜色。

### 5. 单审员，不做双人复核

`store_roles` 的 `moderator|admin` 即可批准，包括自己提交的产品。理由：单 issuer 拓扑下审核
员本来就只有少数几个人（Q1），双人复核会让小部署无法上线。审计表记录了 actor，事后可追责。
多人复核作为 S6 的可选策略。

### 6. 证据与状态同事务

状态变更、`moderation_events`、`audit_log` 在同一个事务里写入；审核动作要么全成，要么全不成
（§7.4 第 19 条，测试用“事件写入故意失败”验证回滚）。

### 7. 下架与撤回

- 开发者 `yank` 单个版本：立即生效（目录、详情、下载 410），重算 latest。
- 审核员 `delist` 整个产品：目录消失、详情 404、下载 410。重新上线必须重新提交与审核
  （`delisted → pending_review`），不提供“一键恢复”。

## 放弃的方案

- **rename 立即下架重审**：一次文案修改就会让线上产品消失、并让在途安装 410。
- **只审产品、不审版本**：无法表达“同一产品的新版本引入了新能力”。
- **按 semver 或发布时间自动放行**：与“能力变更才是风险来源”的事实无关。
- **审核状态塞进 `release_versions.state` 单轴**：首审与复审的语义不同，合并后无法区分
  “产品还没上线”和“这个版本在等复审”。

## 代价与重开条件

- 快照是三个字段（名称、仓库、能力集合）的复制，改名后要等下一个版本才被“接受”；如果产品
  长期不发新版，审核页会一直挂着 `productRenamed` 提示。
- 能力分级缺失会带来低价值复审；能力目录定稿（S6）后重开第 4 条。
- 若将来引入多 issuer / 多人审核，第 5 条需要重开（至少要求非提交人批准）。

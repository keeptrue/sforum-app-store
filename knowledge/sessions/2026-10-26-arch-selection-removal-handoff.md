# 2026-10-26 架构选择移除交接

## Changed

- 目录恒发 `platform=all`（`buildCatalogPath`）；删掉「只看支持当前架构」开关、`platformOnly`
  状态与对应的 change 监听。
- 安装条删掉平台下拉（`foot.ts` 的 `platformChoices` 一并删除）；平台恒由 `defaultPlatform`
  自动决定（精确 → `any/any` → 第一项），版本下拉独占一行。
- 卡片新增正向判决 `支持当前架构`（ok）；它顶掉原始平台 chip（清单进 `title`）。
  负向判决保留 chip；`supported === false && supportedAnywhere === false` 时抑制兼容徽标。
- 安装条空闲且可装、且该版本支持宿主时显示 `支持当前架构（linux/amd64）`（ok）。
- 文案：删 `platformFilterAction` / `platformSelectAria`，加 `platformSupportedBadge` /
  `platformSupportedState`（zh + en）。
- 服务端、OpenAPI、Go 后端零改动：`platform=strict|all` 契约保留，页面把 `all` 当默认值用满。

## 证据

- 插件前端 `bun test plugin/plugins/sforum.store/frontend/admin/src`：**162 pass / 0 fail /
  900 expect**。
- `bash plugin/scripts/build.sh`：manifest OK；`catalog.mjs` 56,283 B（预算 81,920）、
  `catalog.css` 18,099 B（预算 20,480）；摘要已同步。
- 后端 `go vet ./...` + `go test ./...` 绿（后端未改）。
- 宿主真机（SForum dev，store 插件 active digest `2e21b8d6…`）：
  `GET /api/v1/extensions/sforum.store/api/store/catalog?channel=stable&platform=all` → 200；
  卡片 `支持当前架构`（`title` 带平台清单）；安装条 `支持当前架构（linux/amd64）`；
  页面无架构开关、弹窗无平台下拉；桌面 1569×763 与 390×844 各一组截图，
  移动端 footer 为「版本下拉 / 状态位 / 主按钮」三行，无横向溢出。

## Decisions

- `decisions/2026-10-26-arch-auto-detect.md` —— 取代 `2026-10-26-platform-availability.md`
  的 UI 与默认口径部分。

## Next

- 目录里异架构产品与可安装产品混排；产品变多时再评估「支持优先」排序。
- 公开站与插件页的架构口径仍未统一（公开站没有 `target`，只能按浏览者推断或不做判决）。

## Open Questions

- 详情里是否补一处完整平台清单（目前只在卡片 tooltip 与安装条的状态位）。

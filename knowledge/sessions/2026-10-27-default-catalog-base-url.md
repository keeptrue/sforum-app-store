# 默认商城地址改为 app-store.dalao.me（插件 0.1.4）

## 做了什么

- `manifest/settings.json`：`sforum.store.catalog_base_url` 的 `default` 从空串改成
  `https://app-store.dalao.me`，设置页预填、「恢复推荐默认值」回到这个地址。
- `backend/settings.go`：新增 `resolveCatalogBaseURL`。默认值只用在「宿主 own-settings 里
  **没有**这个键」的场景（新装、从未保存）；键存在但为空/空白/非 https 一律按运营显式清空 →
  保持未配置，页面只显示配置提示、不发请求。
- 版本 `0.1.3 → 0.1.4`；`bash plugin/scripts/build.sh` 重建后后端摘要
  `d069655995cb33d86c14a55904173468db2b6f0dc51af1b18381af3ef6f6d8a4`（18 个 packageFiles 未变）。
- 决策 `decisions/2026-10-27-default-catalog-base-url.md`；`docs/plugin.md` 与
  `docs/deployment.md` 的默认值口径同步。

## 证据

- 后端 `go vet ./...` + `go test ./...` 通过（新增 `settings_test.go`：8 个表驱动用例 +
  1 条「显式清空不被默认值拉回」断言）。
- 前端 `bun test plugin/plugins/sforum.store/frontend/admin/src` → **216 pass / 0 fail**。
- 宿主闸门（SForum `799da5e49`，其 `apps/api` 与 pin `600fa68e6` 无差异）：
  `extension digest --write` / `validate` / `test` / `brand check` 全绿，0.1.4、7 routes、2 pages。
- 目标商城 `https://app-store.dalao.me/api/health` → 200，`publicUrl` 与
  `publicUrlSource=database` 都指向该地址；`downloadAuthMode=anonymous`。

## 发布与后续

- tag `v0.1.4` 触发 `release.yml`：四平台包 + `SHA256SUMS` + GitHub Release。
- 存量站点若已保存过空值，不会被新默认覆盖（键存在即显式值）；要跟随就点
  「恢复推荐默认值」或手填 https 基址。

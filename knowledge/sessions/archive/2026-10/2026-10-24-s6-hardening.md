# 2026-10-24 Session Handoff — S6 加固与文档

## Changed

### 限流（`src/lib/ratelimit/**` + 迁移 `0005`）

- 新表 `rate_limits(bucket, window_start, count)`，主键 `(bucket, window_start)`，
  写入是原子 upsert（`ON CONFLICT DO UPDATE SET count = count + 1`）；窗口起点 =
  `floor(now / windowSeconds)`。过期窗口在写入路径按 2% 概率顺手清理（`window_start < 两个窗口前`）。
- `rules.ts`：`<limit>/<seconds>` 解析，五个通道各有默认值与 env 覆盖
  （`STORE_RATELIMIT_{LOGIN,SUBMIT,DOWNLOAD_IP,DOWNLOAD_TOKEN,REPO}`）；**写错在启动时抛
  `ConfigError`**，不会静默变成不限流。
- `limiter.ts`：`consumeRateLimit` 返回 `{ok, remaining|retryAfterSeconds}`；存储不可用时
  **fail-open**（放行 + `console.warn`），因为限流表挂掉不该把登录和下载一起打死。
- `enforce.ts`：`enforceChannelLimit` 统一产出 429（`{code:"rate_limited"}` +
  `Retry-After` + `no-store`），路由不再各自拼错误体。
- 接入点：登录 start + callback（按 IP）、dashboard 写操作（按账号，GET 不消耗）、
  `download-urls` 与 `download/{token}`（按 IP + 按 token，token 只存 sha256 前 32 位）、
  `github/install/start`（按账号）。

### 审计

- 登录成功/失败都写 `audit_log`：`auth.login.succeeded` / `auth.login.failed`，带原因码
  （`provider_*`、`missing_code_or_state`、`state_mismatch`、OAuth 错误码）与 IP；
  审计写入失败只 warn，不阻断登录。
- 限流触发只写日志不写审计（避免攻击时把审计表打爆）。

### 文档（`docs/`）

- `deployment.md`：部署矩阵、必需/可选 env 表、首次启动、GitHub App 注册 10 分钟步骤、
  备份与恢复（`pg_dump`/`pg_restore` + 资产卷）、升级与回滚（迁移只前进）、健康与告警、
  限流默认值表。
- `plugin.md`：宿主要求（`10c2b21e8` 的 hostActions）、两种安装方式、设置项、
  「安装只到 staged」的全部语义、网络要求（插件进程出站 https；页面只走同源）、
  故障排查表（not_configured / upstream_error / expected_mismatch / 旧宿主降级 等）、
  构建与宿主三闸命令。
- `developer.md`：登录 → 连仓库 → 发布 release → 审核 → 撤回的完整流程，版本语义
  （manifest 为准、`sforumVersion` 是约束、整版不可变），图片规范，发布前清单，FAQ。

## Verified

- `bun test` → **280 pass / 0 fail / 1123 expect / 30 files**（新增 9 个限流用例）。
- `bun --bun next build` → 通过；`bunx tsc --noEmit` 干净。
- 限流实测（生产构建，把限额压到 3/300、2/300）：
  - 登录：`307 307 307 429`，第 4 次响应 `{"code":"rate_limited"}` + `Retry-After: 19` +
    `Cache-Control: no-store`；
  - `POST /api/v1/download-urls`：`200 200 200 429`；
  - dashboard 写：`201 201 429`，而同一账号的 `GET /api/dashboard/products` 连续 200
    （浏览不消耗提交预算）；
  - `rate_limits` 里可见 `login:ip:::1`、`submit:account:<uuid>`，token 桶只存 hash。
- 回滚演练：`pg_dump --format=custom`（100,679 B）→ 变更（yank 1.4.2 + delist search-site）→
  `pg_restore` 到 `sforum_store_restore` → 服务指向新库启动：`/api/health` 200、
  目录恢复 4 个产品、`1.4.2=published`、`search-site=published`；把 `STORE_ASSET_DIR` 指到空
  目录后 `/api/assets/<sha>` 404、`/p/markdown-plus` 仍 200（资产卷缺失不崩）。
- 真实宿主路径：SForum 自带的安装链集成测试在本机通过
  （`go test ./bootstrap -run TestReferenceSEOFormalZipUploadTrustEnableRestartDisableUpgradeUninstall`
  → `ok 11.09s`，真实 Postgres + 真实协议子进程，覆盖 ZIP→惰性安装→信任→启用→重启→
  staged 升级→回滚→停用→卸载）。
- 插件包未改动：`go test` 28 用例、管理页 28 用例、宿主 `validate`/`test`/`package` 仍全绿。
- **真实宿主装配（本轮新增，成功）**：本地起 SForum API（`APP_ENV=development` + 我们的
  `EXTERNAL_EXTENSION_ROOTS`，Postgres `sforum` 库 + `sforum-redis`），宿主构建并接收包 →
  exact-artifact 存储 → 落库 `enabled`（staged+active）→ **启动我们的 backend 子进程** →
  注册路由（`/api/v1/extensions/sforum.store/api/store/catalog` 返回 401 `auth.required`，
  未知子路径 404）。细节与限制见下。

## Next

1. **本插件包的真实宿主装配**（唯一剩的硬缺口）：把 `plugin/plugins/sforum.store` 装进一个
   运行中的 SForum，点一次安装确认停在 `staged`。最省事的路径：
   `docker compose -f compose.yaml -f compose.dev.yaml up -d postgres redis` +
   本地 API（`APP_ENV=development EXTERNAL_EXTENSION_ROOTS=<repo>/plugin`）+ web dev server，
   然后在后台「应用商城」页点安装。宿主的安装链集成测试已证明该环境可行。
2. 插件 en-US 文案（可选）。
3. 真实 SForum provider 登录与真实 GitHub App 冒烟（S1/S2 起就挂着）。
4. 计划状态：S0–S6 全部完成，**等待人工确认后**把任务书从 `active` 改为 `completed` 并归档。

## Open

- 限流是**固定窗口**：窗口边界会有最多 2× 的瞬时突发（前一窗口末尾 + 新窗口开头）。这是
  明确的取舍；要更平滑就换滑动窗口/令牌桶，但会多一张表或一次读改写。
- 限流的 `Retry-After` 只保证「等到窗口结束」，不保证那时配额一定够（同一 IP 可能被别人用掉）。
- `audit_log` 没有查询 UI；运维直接查库（`docs/deployment.md` 有示例）。
- 备份只覆盖数据库与资产卷；**没有自动化备份任务**，也没有灾备演练脚本（本轮只做了手工演练）。
- 回滚演练是「恢复到新库并切换」，不是原地降级；迁移没有 down，破坏性迁移只能靠恢复备份。
- 插件 en-US 未做；「已装/更新检查」仍缺宿主已装清单的只读面。

## 真实宿主装配（复现步骤与限制）

**已做到**：包被宿主接受、复制进 `storage/extensions/sforum.store/0.1.0/<package_digest>/`、
在 `extensions` 表里 `status=enabled`、`active_version_id`/`staged_version_id` 都非空、
`backend/plugin` 作为 go-plugin 子进程运行、清单里的两条 GET 路由被注册且由
`core.guard.login` 拦截（401 `auth.required`），未知子路径 404。

```bash
# 1) SForum 侧准备（只读使用检出，DB/Redis 用本机容器）
docker exec -e PGPASSWORD=sforum sforum-postgres psql -U sforum -d postgres -c "CREATE DATABASE sforum OWNER sforum"  # 已存在则跳过
mkdir -p /tmp/empty-builtins   # 检出里的 builtin 二进制摘要不一致，dev 装配时先隔离掉

# 2) 启动 API（在 SForum/apps/api 下）
env APP_ENV=development APP_URL=http://127.0.0.1:3000 \
    DATABASE_URL="postgres://sforum:sforum@127.0.0.1:15432/sforum?sslmode=disable" \
    REDIS_ADDR=127.0.0.1:16379 REDIS_PASSWORD=sforum-dev-redis \
    HTTP_HOST=127.0.0.1 HTTP_PORT=8087 BUILTIN_EXTENSION_ROOT=/tmp/empty-builtins \
    EXTERNAL_EXTENSION_ROOTS=/home/inkedus/Code/github/sforum-app-store/plugin \
    go run ./cmd/api

# 3) 观察
#    dev plugin watcher: package built … sforum.store
#    extensions 表出现 sforum.store（enabled）
#    ps 里出现 storage/extensions/sforum.store/.../backend/plugin
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8087/api/v1/extensions/sforum.store/api/store/catalog  # 401
```

**没做到（环境约束，不是实现缺陷）**：带登录会话的页面点击、以及
`bridge.installExtension` → `POST /admin/extensions/install-from-url` 的真实 HTTP 跳转。
原因：宿主下载器只接受**公网 HTTPS**（`AllowHTTP`/`AllowPrivate` 是 test-only 开关，生产/开发
装配都不打开），本地没有公网可达的 HTTPS 源。另外 dev 装配的自动提升要求扩展声明
lifecycle V2（`dev auto: promote failed … requires a manual admin restart bridge`），生产路径
不受此限——管理员在 core 里信任/启用即可。

**副作用**：`sforum` 库里现在留着 `sforum.store` 的 enabled 行，`SForum/storage/extensions/`
下有它的包副本；两个旧 digest 是 dev watcher 重建产生的。要清理就删库行与目录。

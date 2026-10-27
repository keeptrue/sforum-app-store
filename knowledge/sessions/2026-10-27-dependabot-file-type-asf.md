# Dependabot #1：file-type ASF 死循环（插件 0.1.5）

## 告警

`repos/keeptrue/sforum-app-store/dependabot/alerts/1`（2026-10-25 创建，medium）：
`service/package.json` 的直接运行时依赖 `file-type@^19` 落在 `>=13.0.0, <21.3.1` 区间内，
命中 GHSA-5v7r-6r5c-r473 / CVE-2026-31808——ASF（WMV/WMA）解析器遇到子头 `size=0` 时
`payload = -24`，`tokenizer.ignore(-24)` 把读位置往回挪，同一个子头被无限重读，55 字节
就能卡死 Node 事件循环。

对本仓的实际影响面是**产品图片上传**：`src/lib/storage/image.ts` 的 `validateImage` 把
用户上传的字节交给 `fileTypeFromBuffer`，而这是唯一一处 `file-type` 调用点。

## 做了什么

- `service/package.json`：`file-type` `^19` → `^21.3.1`；`bun install` 解析到 **21.3.4**。
  锁文件只动了 `file-type` 这棵树：`file-type 19.6.0 → 21.3.4`、`strtok3 9.1.1 → 10.6.3`、
  新增 `@tokenizer/inflate`，移掉 `get-stream` / `@sec-ant/readable-stream` / `is-stream` /
  `peek-readable`。
- 不选 22.x：它要求 Node 22，而本仓运行时是 Bun 1.4.2、Node 只是 `next start` 的回退路径；
  21 线只要求 `>=20`。API 没变（仍是 `fileTypeFromBuffer`），v20 移除的
  `NodeFileTypeParser` 与 v22 移除的子导出本仓都没用到。
- 回归用例 `src/lib/storage/image.test.ts`「returns instead of spinning on a malformed ASF
  header」：65 字节夹具（10 字节 ASF 签名 + 30 字节 prelude + 16 字节 GUID + 8 字节
  `size=0` + 1 字节让扫描循环条件成立）。**已验证这条用例有牙**：同一夹具在
  `file-type@19.6.0` 下 `timeout 5` 直接 124（挂死），在 21.3.4 下返回 `undefined`，
  `validateImage` 落到 `unsupported_image`。
- 版本 `0.1.4 → 0.1.5`（清单）；`bash plugin/scripts/build.sh` 重建后 **digests 0 updated**，
  清单 18 个 packageFiles 一个没动——本次不碰插件代码，只换版本号。

## 证据

- `bun test src/lib/storage/image.test.ts` → 8 pass（含新用例）。
- `bun run test` → **885 pass / 0 fail / 74 files**（Postgres 走 `127.0.0.1:15432` 容器）。
- `bun run typecheck` → 0；`bun run build`（`bun --bun next build`）→ 0。
- 宿主侧未重跑（本机 `../SForum` 在，但清单与包内容除版本号外无变化；`build.sh` 的
  `validate-manifest` 已绿）。发布闸门由 `release.yml` 的 `extension validate/test/brand check`
  兜底。

## 发布

- tag `v0.1.5` 同时触发两条流水线：`release.yml`（四平台插件包 + `SHA256SUMS` + Release）与
  `docker.yml`（`ghcr.io/keeptrue/sforum-app-store:0.1.5` + `0.1` + `latest`）。
- 告警关闭条件：默认分支的依赖图看到 `file-type >= 21.3.1`（即本次 lockfile 推送）后，
  Dependabot 自动把 #1 标成 fixed；若没有自动关，就 `PATCH /dependabot/alerts/1`
  写 `{"state":"fixed"}`（`fixed_at` 需要等重新扫描，不能手填）。

## 结果（2026-10-27 22:45 +08:00）

- Dependabot #1 **自动转 `fixed`**，`fixed_at = 2026-10-27T14:36:20Z`（push 后 1 秒，默认分支
  依赖图看到 `file-type@21.3.4`），不需要手工 PATCH。
- `release.yml` run `40522716501` 1m50s 全绿：v0.1.5 Release 带四平台 zip + SBOM +
  `SHA256SUMS`；本地 `sha256sum -c` 对 `linux_amd64` 通过，包内清单 `0.1.5` / 7 routes /
  18 packageFiles。
- `docker.yml` run `40522716342` 全绿：verify-tag → build（amd64+arm64）→ smoke（真 Postgres
  跑 migrate + web + worker）→ note-arm64。镜像 tag `0.1.5` / `0.1` / `latest`。
- `ci.yml`（main）run `40522704666` 1m37s 全绿。

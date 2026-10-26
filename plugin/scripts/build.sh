#!/usr/bin/env bash
# 构建 sforum.store 包：Go 后端 → 管理页产物 → 摘要 → 校验。
# 管理页是手写 ESM：src 是可读源码，dist 是打包产物（两者都 minify，与 .mjs 同一口径）。
set -euo pipefail
cd "$(dirname "$0")/../plugins/sforum.store"

echo "== backend =="
(cd backend && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags="-s -w" -o plugin ./)

echo "== admin page =="
bun build frontend/admin/src/catalog.ts --target=browser --format=esm --minify --outfile=frontend/admin/dist/catalog.mjs
# CSS 也走产物化：源文件留注释与分行（人读），dist 只留声明（浏览器读）。体积预算
# （计划 §7.5 第 17 条 20 KB）说的是**发布产物**，不是源码；否则每加一块 UI 都要先删
# 等量的说明性排版才能过闸。
bun build frontend/admin/src/catalog.css --minify --outfile=frontend/admin/dist/catalog.css

echo "== digests =="
bun ../../scripts/sync-digests.mjs

echo "== manifest =="
(cd backend && go run ./cmd/validate-manifest ..)

echo "== sizes =="
wc -c backend/plugin frontend/admin/dist/catalog.mjs frontend/admin/dist/catalog.css

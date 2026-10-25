#!/usr/bin/env bash
# 构建 sforum.store 包：Go 后端 → 管理页产物 → 摘要 → 校验。
# 管理页是手写 ESM（无构建步骤），dist 即产物；这里只做语法检查与复制。
set -euo pipefail
cd "$(dirname "$0")/../plugins/sforum.store"

echo "== backend =="
(cd backend && CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags="-s -w" -o plugin ./)

echo "== admin page =="
bun build frontend/admin/src/catalog.ts --target=browser --format=esm --minify --outfile=frontend/admin/dist/catalog.mjs
cp frontend/admin/src/catalog.css frontend/admin/dist/catalog.css

echo "== digests =="
bun ../../scripts/sync-digests.mjs

echo "== manifest =="
(cd backend && go run ./cmd/validate-manifest ..)

echo "== sizes =="
wc -c backend/plugin frontend/admin/dist/catalog.mjs frontend/admin/dist/catalog.css

#!/usr/bin/env bash
# 构建 sforum.store 包：Go 后端 → 管理页产物 → 摘要 → 校验。
# 管理页是手写 ESM：src 是可读源码，dist 是打包产物（两者都 minify，与 .mjs 同一口径）。
set -euo pipefail
cd "$(dirname "$0")/../plugins/sforum.store"

echo "== backend =="
# 两个构建者（core dev watcher 与这个脚本）必须产出逐字节相同的二进制，否则
# manifest 的 backend.digest 会在两个值之间抖动。要消掉两个变量，规则与 core
# 的 ExtensionPackage.backendBuildPlan 同源：
#   1. `go` 指令只是下限 —— 本机 Go 更新时会用本机版本，CI 用 setup-go 按同一条
#      指令装的精确版本。⇒ GOTOOLCHAIN 钉到 go.mod 的 go 行。
#   2. replace 的文件系统路径会被逐字写进 buildinfo，而本地兄弟布局与 CI 的嵌套
#      布局深度必然不同。⇒ 用临时 go.work 承载同一组模块，workspace 解析不经过
#      replace，路径因此不进二进制。
GO_VERSION="$(awk '/^go /{print $2; exit}' backend/go.mod 2>/dev/null || true)"
# 只有 x.y.z 才钉：`go 1.26` 这种两段式在 GOTOOLCHAIN 里是非法/歧义取值。
case "$GO_VERSION" in
  *.*.*) ;;
  *) GO_VERSION="" ;;
esac
if [ -n "$GO_VERSION" ]; then
  export GOTOOLCHAIN="go$GO_VERSION"
  echo "toolchain: $GOTOOLCHAIN"
else
  echo "toolchain: (backend/go.mod 无 go 指令，沿用默认)"
fi
REPLACE_PATHS="$(awk '
  /^[[:space:]]*replace[[:space:]]*\(/ { block=1; next }
  block && /^[[:space:]]*\)/ { block=0; next }
  {
    line=$0
    if (!block && line !~ /^[[:space:]]*replace[[:space:]]/) next
    if (!block) sub(/^[[:space:]]*replace[[:space:]]+/, "", line)
    if (!match(line, /=>/)) next
    target=substr(line, RSTART+2)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", target)
    if (target ~ /^\./ || target ~ /^\//) print target
  }
' backend/go.mod 2>/dev/null || true)"
if [ -n "$REPLACE_PATHS" ]; then
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT
  {
    [ -n "$GO_VERSION" ] && printf 'go %s\n\n' "$GO_VERSION"
    printf 'use (\n\t%s/backend\n' "$PWD"
    printf '%s\n' "$REPLACE_PATHS" | while IFS= read -r target; do
      case "$target" in
        /*) printf '\t%s\n' "$target" ;;
        *) printf '\t%s\n' "$(cd "$PWD/backend" && cd "$target" && pwd)" ;;
      esac
    done
    printf ')\n'
  } > "$WORK_DIR/go.work"
  export GOWORK="$WORK_DIR/go.work"
  echo "workspace: 临时 go.work（$(printf '%s\n' "$REPLACE_PATHS" | wc -l | tr -d ' ') 个 replace 目标）"
else
  export GOWORK=off
  echo "workspace: 无文件系统 replace，GOWORK=off"
fi
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

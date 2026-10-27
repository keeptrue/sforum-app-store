#!/usr/bin/env bash
#
# 容器「能用」的硬证据。对同一个镜像跑三个角色，打一个真实 Postgres：
#
#   1. migrate  —— 一次性，退出码 0 且打印 migrations applied（drizzle 目录 + cwd 都对）
#   2. web      —— 镜像自带 HEALTHCHECK 变 healthy，且 /api/health 里 status=ok 没有 configError
#   3. worker   —— 日志出现 [worker] ready（pg-boss 真的连上了库）
#
# CI 由 .github/workflows/docker.yml 的 smoke job 调用，走的是**本地构建**那条：
# 它先 `docker/build-push-action` 带 `load: true` 出 `sforum-app-store:smoke`，再跑本脚本
# —— CI 不会去拉一个还没推上去的镜像。
#
# 两条路径都支持（IMAGE 不存在时脚本自己 docker pull）：
#
#   本地构建：docker build -t sforum-app-store:smoke . && bash scripts/docker/smoke.sh
#   GHCR 镜像：IMAGE=ghcr.io/keeptrue/sforum-app-store:edge bash scripts/docker/smoke.sh
#
# 需要一个宿主可达的 Postgres（CI 用 postgres service；本地一条 docker run 即可）：
#   docker run -d --name smoke-db -e POSTGRES_USER=store -e POSTGRES_PASSWORD=store \
#     -e POSTGRES_DB=store -p 5432:5432 postgres:17-alpine
#   DATABASE_URL=postgres://store:store@127.0.0.1:5432/store bash scripts/docker/smoke.sh
#
# 三个角色跑在专用 docker 网络里，不占用宿主端口（宿主的 4000 可能被 dev server 占着），
# 也不需要 --network host：DATABASE_URL 里的 127.0.0.1/localhost 会自动改写成
# host.docker.internal（--add-host=host.docker.internal:host-gateway）。
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-sforum-app-store:smoke}"
DATABASE_URL="${DATABASE_URL:-postgres://store:store@127.0.0.1:5432/store}"
NET="${SMOKE_NETWORK:-store-smoke-net}"
WEB_NAME="store-smoke-web"
WORKER_NAME="store-smoke-worker"

log() { printf '\033[1m[smoke]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[smoke]\033[0m %s\n' "$*" >&2; exit 1; }

rand_b64() {
  local bytes="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n'
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
  fi
}

# 容器内的库地址：宿主上的 127.0.0.1 在容器里是它自己。
CONTAINER_DATABASE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#@(127\.0\.0\.1|localhost)([:/])#@host.docker.internal\2#')"

# 一次性密钥：只活在这个脚本里，与 .env 无关。
SESSION_SECRET="$(rand_b64 48)"
DOWNLOAD_SECRET="$(rand_b64 48)"
SECRET_KEYS="smoke:$(rand_b64 32)"

RUN_ARGS=(
  --network "$NET"
  --add-host=host.docker.internal:host-gateway
  -e "NODE_ENV=production"
  -e "DATABASE_URL=${CONTAINER_DATABASE_URL}"
  -e "STORE_PUBLIC_URL=http://127.0.0.1:4000"
  -e "STORE_SESSION_SECRET=${SESSION_SECRET}"
  -e "STORE_DOWNLOAD_SECRET=${DOWNLOAD_SECRET}"
  -e "STORE_SECRET_KEYS=${SECRET_KEYS}"
  -e "STORE_ASSET_DIR=/var/lib/sforum-store/assets"
  -e "STORE_BUILD_VERSION=smoke"
  -e "STORE_BUILD_COMMIT=${GITHUB_SHA:-local}"
)

cleanup() {
  docker rm -f "$WEB_NAME" "$WORKER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

# 失败时先把日志 tail 出来**再**清理容器 —— 容器一删，CI 里再补一步 `docker logs` 就只能
# 拿到 "No such container"。所以日志收集放在 trap 里，workflow 不需要额外的 dump 步骤。
dump_logs() {
  local name
  for name in "$WEB_NAME" "$WORKER_NAME"; do
    if docker inspect "$name" >/dev/null 2>&1; then
      printf '\n----- %s (last 60 lines) -----\n' "$name" >&2
      docker logs --tail 60 "$name" 2>&1 | sed 's/^/  /' >&2 || true
    fi
  done
}

on_exit() {
  local code=$?
  if (( code != 0 )); then
    dump_logs
  fi
  cleanup
  exit "$code"
}
trap on_exit EXIT

# 容器内取一次 health（web 不发布宿主端口，所以从容器里发请求）。
container_health() {
  docker exec "$WEB_NAME" bun -e 'const r = await fetch("http://127.0.0.1:4000/api/health"); console.log(await r.text())'
}

cleanup
docker network create "$NET" >/dev/null

# 本地构建的镜像直接用；给了 GHCR tag 而本地没有就先拉（CI 不走这条，它 load 本地镜像）。
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "使用本地镜像 $IMAGE"
else
  log "本地没有 $IMAGE，docker pull"
  docker pull "$IMAGE" || die "拉取 $IMAGE 失败（私有镜像先 docker login ghcr.io）"
fi

# ---- 1. migrate ------------------------------------------------------------
log "migrate：$IMAGE"
migrate_out="$(docker run --rm "${RUN_ARGS[@]}" --entrypoint bun "$IMAGE" src/db/migrate.ts 2>&1)" \
  || { printf '%s\n' "$migrate_out" >&2; die "migrate 失败"; }
printf '%s\n' "$migrate_out"
case "$migrate_out" in
  *"migrations applied"*) ;;
  *) die "migrate 没有打印 migrations applied" ;;
esac

# ---- 2. web ----------------------------------------------------------------
log "web：$IMAGE"
docker run -d --name "$WEB_NAME" "${RUN_ARGS[@]}" "$IMAGE" >/dev/null

status=""
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WEB_NAME" 2>/dev/null || echo unknown)"
  [[ "$status" == "healthy" ]] && break
  [[ "$status" == "exited" ]] && break
  sleep 2
done

if [[ "$status" != "healthy" ]]; then
  docker logs "$WEB_NAME" >&2 || true
  die "web 未变 healthy（当前 $status）"
fi

body="$(container_health)" || { docker logs "$WEB_NAME" >&2 || true; die "GET /api/health 失败"; }
log "health: $body"
case "$body" in
  *'"status":"ok"'*) ;;
  *) die "health 未返回 status=ok" ;;
esac
case "$body" in
  *configError*) die "health 报告 configError" ;;
esac

# 一页 SSR 也要通：首页从库里读目录，顺带覆盖 markdown/sanitize-html 这条渲染链。
code="$(docker exec "$WEB_NAME" bun -e '
  const r = await fetch("http://127.0.0.1:4000/");
  console.log(r.status);
')"
log "GET / → $code"
[[ "$code" == "200" ]] || { docker logs "$WEB_NAME" >&2 || true; die "首页不是 200（$code）"; }

# ---- 3. worker -------------------------------------------------------------
log "worker：$IMAGE"
# worker 没有 HTTP 面，镜像自带的 HEALTHCHECK 是 web 的探针（会一直失败），所以这里显式
# 换成 compose 里那条 /proc/1 探针 —— 顺手把 compose 的探针字符串也验一遍。
docker run -d --name "$WORKER_NAME" "${RUN_ARGS[@]}" \
  --health-cmd "tr '\\0' ' ' < /proc/1/cmdline | grep -q 'src/worker.ts'" \
  --health-interval 15s --health-timeout 3s --health-retries 3 --health-start-period 30s \
  "$IMAGE" bun src/worker.ts >/dev/null

ready=""
for _ in $(seq 1 45); do
  if docker logs "$WORKER_NAME" 2>&1 | grep -q '\[worker\] ready'; then ready=1; break; fi
  [[ "$(docker inspect --format '{{.State.Status}}' "$WORKER_NAME")" == "exited" ]] && break
  sleep 2
done

docker logs "$WORKER_NAME" 2>&1 | tail -20
[[ -n "$ready" ]] || die "worker 没有打出 [worker] ready"

# worker 健康检查也要过（compose 用的就是这条 /proc/1 探针）。镜像的 start_period 是 30s，
# 首轮 interval 15s，所以「healthy」最早也要 30–45s 才出现，这里给到 120s。
health=""
for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$WORKER_NAME")"
  [[ "$health" == "healthy" ]] && break
  sleep 2
done
log "worker health: $health"
[[ "$health" == "healthy" ]] || die "worker 健康检查没过（$health）"

log "全部通过"

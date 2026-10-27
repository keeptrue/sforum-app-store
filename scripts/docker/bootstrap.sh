#!/usr/bin/env bash
#
# 一条命令拉起整套商城（web + worker + 迁移 + 内置 Postgres）：
#
#   bash scripts/docker/bootstrap.sh
#
# 幂等：.env 已存在就复用，不覆盖任何已有密钥。流程 = 检查 .env → 拉镜像 → up -d →
# 等 web 健康 → 打印 /api/health 的响应体。缺密钥不兜底：宁可这里退出，也不要拿弱默认值
# 起一个看起来正常的部署。
#
# 常用变体：
#   STORE_IMAGE=sforum-app-store:local bash scripts/docker/bootstrap.sh   # 用本地构建的镜像
#   bash scripts/docker/bootstrap.sh status|logs|down
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"

log() { printf '\033[1m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

env_get() {
  # 从 .env 读一个键（只取第一个 = 之后的内容；键不存在时输出空串）。
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

rand_b64() {
  local bytes="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n'
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
  fi
}

rand_hex() {
  local bytes="${1:-16}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes" | tr -d '\n'
  else
    od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
  fi
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die "找不到 docker"
  docker compose version >/dev/null 2>&1 || die "找不到 docker compose（需要 v2 插件）"
}

write_env() {
  local pg_pass session download keyring setup_token kid port
  # 数据库口令进 URL，只用 hex，避免 base64 的 / + = 需要转义。
  pg_pass="$(rand_hex 16)"
  session="$(rand_b64 48)"
  download="$(rand_b64 48)"
  kid="$(date -u +%Y%m)"
  keyring="${kid}:$(rand_b64 32)"
  setup_token="$(rand_b64 32)"
  # 地址跟着端口走：`STORE_HTTP_PORT=4104 bootstrap.sh` 生成的必须是
  # http://127.0.0.1:4104，否则发出去的 OAuth 回调 / 下载短链全指回 4000。
  port="${STORE_HTTP_PORT:-4000}"

  umask 077
  cat > "$ENV_FILE" <<EOF
# 由 scripts/docker/bootstrap.sh 生成。随机密钥只在这里出现一次，不要提交
# （.gitignore 已挡 .env）。改完执行 docker compose up -d 生效。

# 访客真实使用的地址。默认 loopback（production 下 http 只允许 loopback）。
# 挂反向代理 / 隧道时改成对外地址，否则 OAuth 回调、下载短链、同源判断都指回本机。
STORE_PUBLIC_URL=${STORE_PUBLIC_URL:-http://127.0.0.1:${port}}
# 宿主端口。改这里要同步改上面的 STORE_PUBLIC_URL；宿主端口被占时 bootstrap 会直接拒绝。
STORE_HTTP_PORT=${port}

# 管理后台路径（单段，默认 admin）。取消注释并重启即可换：/console 之类。
# 留空 = admin；/api、/dashboard、/moderation、/p、/_next 是保留字，填了会启动失败。
# STORE_ADMIN_PATH=admin

# 内置 Postgres（compose 的 db 服务）。要接外部库就改 DATABASE_URL；
# 外部角色需要对库有 CREATE 权限（pg-boss 自建 pgboss schema）。
# 接外部库时 POSTGRES_PASSWORD 仍要留一个非空值（compose 会实例化 db 服务），不会被使用。
POSTGRES_USER=store
POSTGRES_PASSWORD=${pg_pass}
POSTGRES_DB=store
DATABASE_URL=postgres://store:${pg_pass}@db:5432/store

STORE_SESSION_SECRET=${session}
STORE_DOWNLOAD_SECRET=${download}
STORE_SECRET_KEYS=${keyring}

# 首个管理员的一次性注册令牌。必须 ≥32 字符（不足会在启动时抛 ConfigError），
# 留空/删掉这一行 = 关闭注册入口。注册完删掉这一行并重启即可。
STORE_ADMIN_SETUP_TOKEN=${setup_token}
EOF
  chmod 600 "$ENV_FILE"
  log "已生成 $ENV_FILE（权限 600）"
  local admin_path port
  admin_path="$(resolve_admin_path)"
  port="$(resolve_port)"
  echo
  echo "  首个管理员注册令牌（一次性，注册后建议删除该行）："
  echo "    STORE_ADMIN_SETUP_TOKEN=${setup_token}"
  echo "  注册地址：http://127.0.0.1:${port}/${admin_path}/setup"
  echo
}

check_env() {
  local missing=()
  local key
  for key in DATABASE_URL STORE_SESSION_SECRET STORE_DOWNLOAD_SECRET STORE_SECRET_KEYS POSTGRES_PASSWORD; do
    [[ -n "$(env_get "$key")" ]] || missing+=("$key")
  done
  if (( ${#missing[@]} > 0 )); then
    die ".env 缺少必填项：${missing[*]}。补上，或删掉 .env 让 bootstrap 重新生成。"
  fi
}

pull_images() {
  local image="${STORE_IMAGE:-$(env_get STORE_IMAGE)}"
  image="${image:-ghcr.io/keeptrue/sforum-app-store:edge}"
  export STORE_IMAGE="$image"

  if docker image inspect "$image" >/dev/null 2>&1; then
    log "本地已有 $image，跳过应用镜像拉取（只拉 postgres）"
    docker compose pull db
  else
    log "拉取 $image 与 postgres:17-alpine"
    docker compose pull || die "拉取失败。私有镜像先 docker login ghcr.io；本地构建用 STORE_IMAGE=sforum-app-store:local。"
  fi
}

resolve_port() {
  local port="${STORE_HTTP_PORT:-$(env_get STORE_HTTP_PORT)}"
  printf '%s' "${port:-4000}"
}

# 后台路径以 .env 为准（shell 里导出的同名变量优先），空值 = admin。
resolve_admin_path() {
  local path="${STORE_ADMIN_PATH:-$(env_get STORE_ADMIN_PATH)}"
  printf '%s' "${path:-admin}"
}

# 复用已有 .env 时的端口/地址对齐：只有 shell **显式**给了 STORE_HTTP_PORT 才动手。
# - STORE_HTTP_PORT 总是写进 .env（否则下次裸跑 `docker compose up -d` 会回到旧端口）；
# - STORE_PUBLIC_URL 只在它是 loopback（http://127.0.0.1:<port> / localhost / [::1] / 空）
#   时跟随端口改写；用户写了真实域名或 https 就一字不动 —— 那是特意配的（多半前面有反代，
#   宿主端口和对外地址本来就不同源）。
align_public_url() {
  local port url tmp follow_url=1
  [[ -n "${STORE_HTTP_PORT:-}" ]] || return 0
  port="$(resolve_port)"
  url="$(env_get STORE_PUBLIC_URL)"
  if [[ -n "$url" ]] && ! printf '%s' "$url" | grep -qE '^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/?$'; then
    follow_url=0
  fi

  tmp="$(mktemp)"
  sed -E "s#^STORE_HTTP_PORT=.*#STORE_HTTP_PORT=${port}#" "$ENV_FILE" > "$tmp"
  grep -q '^STORE_HTTP_PORT=' "$tmp" || printf 'STORE_HTTP_PORT=%s\n' "$port" >> "$tmp"
  if (( follow_url )); then
    sed -E -i "s#^STORE_PUBLIC_URL=.*#STORE_PUBLIC_URL=http://127.0.0.1:${port}#" "$tmp"
    grep -q '^STORE_PUBLIC_URL=' "$tmp" || printf 'STORE_PUBLIC_URL=http://127.0.0.1:%s\n' "$port" >> "$tmp"
  fi
  # 用重定向写回，保留原文件的属主与 600 权限。
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"

  if (( follow_url )); then
    log "STORE_HTTP_PORT=${port}：.env 的 STORE_PUBLIC_URL / STORE_HTTP_PORT 已同步为 http://127.0.0.1:${port}"
  else
    log "STORE_HTTP_PORT=${port} 已写入 .env；STORE_PUBLIC_URL 保持 ${url}（非 loopback，不跟随端口）"
  fi
}

# 宿主端口被占时 `docker compose up -d` 的**退出码不可依赖**：实测连续 up 时第 2 次
# exit 0 但 web 没有端口映射（容器在跑、外面连不上），第 3 次才 exit 1 且 web 停在 created。
# 所以两道闸都不看退出码：起之前用 ss/lsof 预检端口，起之后用 `docker port` 二次确认映射
# 真的存在（wait_healthy 里那条）。
preflight_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
      die "宿主端口 ${port} 已被占用（ss -ltnp | grep :${port} 可查进程）。改 .env 的 STORE_HTTP_PORT 与 STORE_PUBLIC_URL 后重跑。"
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      die "宿主端口 ${port} 已被占用（lsof -nP -iTCP:${port} 可查进程）。改 .env 的 STORE_HTTP_PORT 与 STORE_PUBLIC_URL 后重跑。"
    fi
  else
    warn "没有 ss/lsof，跳过端口预检"
  fi
}

wait_healthy() {
  local port id status i
  port="$(resolve_port)"

  id="$(docker compose ps -q web)"
  [[ -n "$id" ]] || die "web 容器没有起来：docker compose logs web"

  if [[ -z "$(docker port "$id" 2>/dev/null)" ]]; then
    docker compose ps >&2 || true
    die "web 没有发布端口（宿主 ${port} 可能被占用）。改 .env 的 STORE_HTTP_PORT 后重跑；先 docker compose down 清掉半启动的容器。"
  fi

  log "等待 web 健康（最多 180 秒）"
  status=""
  for i in $(seq 1 90); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
    [[ "$status" == "healthy" ]] && break
    if [[ "$status" == "unhealthy" ]]; then
      docker compose logs --tail=40 web >&2 || true
      die "web 健康检查失败（unhealthy）"
    fi
    sleep 2
  done
  [[ "$status" == "healthy" ]] || { docker compose logs --tail=40 web >&2 || true; die "web 在 180 秒内没有变 healthy（当前 $status）"; }

  local body
  if command -v curl >/dev/null 2>&1; then
    body="$(curl -fsS "http://127.0.0.1:${port}/api/health")" || die "curl http://127.0.0.1:${port}/api/health 失败"
  else
    body="$(docker compose exec -T web bun -e 'const r = await fetch("http://127.0.0.1:4000/api/health"); console.log(await r.text())')" \
      || die "容器内读取 /api/health 失败"
  fi

  echo
  log "/api/health"
  printf '%s\n' "$body"
  case "$body" in
    *'"status":"ok"'*) ;;
    *) die "健康检查未通过：$body" ;;
  esac
  # /api/health 缺配置时仍是 200，所以这里必须看 configError。
  case "$body" in
    *configError*) die "服务报告配置错误：$body" ;;
  esac
}

case "${1:-up}" in
  up)
    require_tools
    if [[ -f "$ENV_FILE" ]]; then
      log "复用已有 .env（不覆盖）"
      align_public_url
    else
      write_env
    fi
    check_env
    preflight_port "$(resolve_port)"
    pull_images
    docker compose up -d
    wait_healthy
    echo
    docker compose ps
    log "完成。管理后台：http://127.0.0.1:$(resolve_port)/$(resolve_admin_path)"
    ;;
  status)
    require_tools
    docker compose ps
    ;;
  logs)
    require_tools
    docker compose logs -f --tail=100
    ;;
  down)
    require_tools
    docker compose down
    warn "卷（pgdata / assets）保留。要连数据一起删：docker compose down -v"
    ;;
  *)
    die "用法：bash scripts/docker/bootstrap.sh [up|status|logs|down]"
    ;;
esac

# syntax=docker/dockerfile:1

# 单镜像多角色：web / worker / migrate 是同一份产物，compose 用不同 command 区分。
#
# 运行时口径跟 AGENTS.md 的「运行时闸门」一致：构建 `bun --bun next build`，运行
# `bun --bun next start` —— 这是 CI 已跑过的路径，不要换成 Node（`next start` 回退 Node
# 只是 Bun 原生依赖失败时的应急选项，不是镜像默认）。
#
# 不引入 `output: "standalone"`：next.config.ts 没有这个配置，Bun 下 nft 的文件追踪
# 也没有证据，v1 就走「完整 .next + node_modules」，行为与 CI 冒烟完全一致。

ARG BUN_IMAGE=oven/bun:1.4.2

# ---------------------------------------------------------------- 构建
FROM ${BUN_IMAGE} AS build
WORKDIR /app

# 依赖层只随 lockfile / workspace 清单变化重建。Bun workspace 的真实包落在
# node_modules/.bun 下，所以必须从仓库根装（service 单装会缺 workspace 解析）。
COPY package.json bun.lock ./
COPY service/package.json service/package.json
RUN bun install --frozen-lockfile

# .dockerignore 已挡掉 .env* / node_modules / .next / tmp / service/.data。
COPY service ./service

# 构建期不需要任何 STORE_* / DATABASE_URL：CI 也是在空环境里跑同一条命令。
# 构建机要能访问 fonts.googleapis.com / fonts.gstatic.com ——
# src/app/layout.tsx 用 next/font/google，字体在构建时下载并自托管进产物。
RUN cd service \
 && bun --bun next build \
 && rm -rf .next/dev .next/cache

# ---------------------------------------------------------------- 运行
FROM ${BUN_IMAGE} AS runtime

# /api/health 会回显这两个值，用来确认线上跑的是哪个 tag / commit。
ARG STORE_BUILD_VERSION=dev
ARG STORE_BUILD_COMMIT=local

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    STORE_BUILD_VERSION=${STORE_BUILD_VERSION} \
    STORE_BUILD_COMMIT=${STORE_BUILD_COMMIT}

WORKDIR /app

# 运行期只装生产依赖：tailwind / typescript / drizzle-kit / openapi-typescript 都只在
# 构建期有用。这里重装而不是拷 service/node_modules —— 那个目录是软链，单独拷必然断。
#
# --chown 不是洁癖：仓库里的 package.json 可能是 0600（私有 checkout / 紧 umask），COPY 会
# 连模式一起带进镜像，bun 用户读不到就在每个进程退出时刷 `Cannot read file "/app/": EACCES`。
# 依赖本身仍由 root 装，node_modules 保持 755/644，bun 可读。
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun service/package.json service/package.json
RUN bun install --frozen-lockfile --production

# .next 必须**整体**进镜像，不能为瘦身只挑 server/static/build：编译产物里有按哈希别名
# 引用的运行期依赖（例如 postcss 在 .next/node_modules/postcss-<hash>，由
# .next/server/app/**/page.js.nft.json 指过去），缺了它 README 渲染链就断。
# .next/dev 与 .next/cache 已在构建阶段删掉，web 进程会往 .next/cache 写图片优化结果，
# 所以下面整体 chown 给运行用户。
COPY --from=build --chown=bun:bun /app/service/.next ./service/.next

# 运行期需要的源码：worker 与 migrate 都是 Bun 直接跑 TypeScript（`@/` 别名靠 tsconfig）。
COPY --from=build --chown=bun:bun /app/service/src ./service/src
# drizzle 目录必须整体进镜像：migrate.ts 读 ./drizzle，缺 meta/_journal.json 会直接报错。
COPY --from=build --chown=bun:bun /app/service/drizzle ./service/drizzle
COPY --from=build --chown=bun:bun /app/service/public ./service/public
COPY --from=build --chown=bun:bun /app/service/tsconfig.json ./service/tsconfig.json
# next.config.ts 要留：`next start` 会用它（Next 自带 SWC 转译 TS 配置，不需要 typescript
# 包），而 poweredByHeader:false 就写在里面 —— 删掉后服务仍能起，但 `X-Powered-By: Next.js`
# 会回来。它 import ./src/lib/dev-origins，所以上面的 src 也不能裁。
COPY --from=build --chown=bun:bun /app/service/next.config.ts ./service/next.config.ts

# 容器内运维脚本。manifest:* / capabilities:* 依赖 contracts 与宿主检出，刻意不进镜像。
COPY --from=build --chown=bun:bun \
     /app/service/scripts/admin-reset-password.ts \
     /app/service/scripts/admin-password.ts \
     /app/service/scripts/settings-public-url.ts \
     /app/service/scripts/readme-rerender.ts \
     /app/service/scripts/backup-legacy-media.ts \
     ./service/scripts/

# 内容寻址图片存储（STORE_ASSET_DIR）。compose 把命名卷挂在 /var/lib/sforum-store，
# 镜像里先建好 assets 并交给运行用户：命名卷首次创建会继承镜像目录的属主，
# 否则卷会归 root，运行时 mkdir 失败。
#
# chmod 那一行不是洁癖：COPY 会把源文件的模式一起带进镜像，而本机 checkout 可能是
# 600（私有仓库 / 紧 umask）。运行用户不是 root，读不到 package.json / tsconfig 就起不来。
# 只放开读与目录进入，不放开写；.next 的属主仍是 bun，缓存照写。
RUN chmod -R a+rX /app \
 && mkdir -p /var/lib/sforum-store/assets \
 && chown -R bun:bun /var/lib/sforum-store

USER bun
WORKDIR /app/service
EXPOSE 4000

# /api/health 故意不因数据库不可达而失败（route.ts 的设计：活着 ≠ 能服务），
# 所以健康检查必须同时看 status 与 configError —— 缺 env 时它照样 200，但带 configError。
# 数据库就绪由 postgres 自己的 pg_isready 负责，不指望这个端点。
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:4000/api/health"); const b = await r.json(); process.exit(r.ok && b.status === "ok" && !b.configError ? 0 : 1)'

# 默认角色是 web。worker / migrate 由 compose 覆盖 command。
# -H 0.0.0.0 显式写出来：next start 不给 hostname 时其实绑全接口（start-server.js 的
# server.listen(port, hostname)），但那是默认行为的副作用，不是契约；写明地址让
# 「容器外访问不到」这类问题不必再猜。
CMD ["bun", "--bun", "next", "start", "-p", "4000", "-H", "0.0.0.0"]

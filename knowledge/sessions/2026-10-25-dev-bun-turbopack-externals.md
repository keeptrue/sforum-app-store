# 2026-10-25 dev 运行时：Bun + Turbopack 的外部模块解析

## 结果

`bun --bun next dev` 在 Next 16.4.3（Turbopack）下必现全站 500，已改成 `dev` 跑 Node：

- `service/package.json:5`：`"dev": "bun --bun next dev -p 4000"` → `"dev": "next dev -p 4000"`。
- 冷启动实测（`rm -rf .next/dev` 后起）：`/` 200、`/api/health` 200、`/p/oauth2-provider` 200，
  日志里 `Failed to load external module` 计数 **0**。
- `bun --bun next build` 退出码 0；`bun --bun next start` 下 `/api/health`、`/p/oauth2-provider`、
  `/`、`/api/v1/catalog` 全 200 —— **生产链路不受影响，build/start 保持 Bun**。
- 决策记录：`decisions/2026-10-25-dev-runtime-node.md`；`AGENTS.md` §运行时闸门 已加 dev 例外。

## 症状

```
⨯ Error: Failed to load external module postcss-cc2117b98292a1b9: ResolveMessage: Cannot find module 'postcss-cc2117b98292a1b9'
Require stack:
- service/.next/dev/server/chunks/ssr/[root-of-the-server]__0hsd97ipqkcnw._.js
    at module evaluation (src/lib/readme/render.ts:3:1)   # import sanitizeHtml from "sanitize-html"
⨯ Error: Failed to load external module pg-a02aabcbe30906cd: Cannot find package 'pg-a02aabcbe30906cd'
    imported from .next/dev/server/chunks/[turbopack]_runtime.js
```

`/p/[slug]` 卡 `sanitize-html → postcss`，`/api/health` 与所有走库的路由卡 `pg`。同一个进程里
每个请求都复现，只有换进程能恢复。

## 根因（两条，缺一不可）

1. **Turbopack dev 的 external 是带哈希的别名。** `postcss`、`pg` 都在 Next 默认
   `serverExternalPackages` 表里（`next/dist/lib/server-external-packages.jsonc:78` 是 postcss）。
   dev chunk 里是 `__turbopack_context__.x("<pkg>-<hash>", () => require("<pkg>-<hash>"))`，解析靠
   Turbopack 事后在 `.next/dev/node_modules/<pkg>-<hash>` 建的软链。同一轮编译的写入顺序（`stat`
   实测）：chunk `06:35:25.259` → 软链 `06:35:25.264` → `build-manifest.json` `06:35:27.730`。
   首次 evaluate 就落在那 5 ms 窗口里。
2. **Bun 缓存解析失败，Node 不缓存。** 同一目录、同一进程内做对照：

   ```
   bun : require 失败 → 建软链 → require 仍然 FAIL: Cannot find module 'pkg-hash'
   node: require 失败 → 建软链 → require OK  (/tmp/nc2-real/pkg-hash/index.js)
   ```

   所以那 5 ms 不是「一次瞬时错误」，而是把 dev 进程永久毒化。

**不是** Bun 解析不了这个别名：全新 Bun 进程 `require` 同一个 chunk 返回 `chunk required OK`，
`Bun.resolveSync("postcss-cc2117b98292a1b9", ".next/dev/server/chunks/ssr/")` 也正常。

**为什么生产没事**：build 时就把软链写好了（`.next/node_modules/{pg,postcss}-<hash>`，mtime 06:44
即构建时刻），`next start` 第一次请求时软链早已存在，竞态窗口不存在。生产 chunk 里同样是
`require("postcss-cc2117b98292a1b9")`，靠 `.next/node_modules` 解析。

## 复现步骤（改回 `--bun` 前必须跑）

```bash
cd service
pkill -f 'next dev -p 40[0]0'          # 注意用 [0] 防止 pkill 匹配到自己这条命令
rm -rf .next/dev
bun run dev                            # 若改回 --bun，这一步就是复现
# 第一次请求任一页面，看 .next/dev/logs/next-development.log 是否出现 Failed to load external module
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/p/<已发布 slug>
```

必现条件：`.next/dev` 被清过（或首次启动）。缓存的 `.next/dev/node_modules` 存在时可能侥幸不触发
——所以「这次没复现」不算验证通过。

## 验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| dev 进程是 Node | `pgrep -af 'next dev -p 4000'` | `node .../service/node_modules/.bin/next dev -p 4000` |
| 冷启动 dev | `rm -rf .next/dev && bun run dev` | `Ready in 779ms`；`/` 200、`/api/health` 200、`/p/oauth2-provider` 200 |
| dev 日志 | `grep -c 'Failed to load external module' /tmp/sforum-dev.log` | `0` |
| 生产构建 | `bun run build` | exit 0，`Compiled successfully in 9.3s` |
| 生产运行 | `bun run start` | `/api/health` 200、`/p/oauth2-provider` 200、`/` 200、`/api/v1/catalog` 200 |
| 生产 external | `ls .next/node_modules` | `pg-<hash>`、`postcss-<hash>` 软链，构建时写入 |
| bun 运行时不带 `--bun` | 临时 package + `#!/usr/bin/env node` bin | `bun runtime: false \| node: v26.10.0` |

## 未验证

- `next dev --webpack` 在 Bun 下是否可用（推断：不行——webpack externals 发真名
  `require("postcss")`，而 `postcss` 是 `sanitize-html` 的传递依赖、Bun 隔离安装不 hoist；
  未实测，因为不需要它）。
- Bun 侧的具体缓存实现（是「负缓存」还是「目录项缓存」未分辨，只证明了失败结果在进程内粘住）。
- CI：本仓 CI 只跑 build + 冒烟，不跑 `next dev`，所以这条约束目前只有本地证据。

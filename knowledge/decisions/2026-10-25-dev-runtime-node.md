# dev 跑 Node，build/start 仍跑 Bun

Status: accepted
Date: 2026-10-25

## 背景

`bun --bun next dev` 在 Next 16.4.3（Turbopack 为默认 bundler）下必现全站 500：

```
Failed to load external module postcss-cc2117b98292a1b9: ResolveMessage: Cannot find module 'postcss-cc2117b98292a1b9'
    at module evaluation (src/lib/readme/render.ts:3:1)     # sanitize-html → postcss
Failed to load external module pg-a02aabcbe30906cd: Cannot find package 'pg-a02aabcbe30906cd'  # /api/health
```

两层原因叠在一起，缺一不可：

1. **Turbopack dev 的 external 是带哈希的别名。** `postcss`、`pg` 都在 Next 的默认
   `serverExternalPackages` 表里（`next/dist/lib/server-external-packages.jsonc:78`），dev chunk 里
   发的是 `__turbopack_context__.x("<pkg>-<hash>", () => require("<pkg>-<hash>"))`，解析依赖
   Turbopack 事后在 `.next/dev/node_modules/<pkg>-<hash>` 建的软链。实测同一轮编译的写入顺序：
   chunk `06:35:25.259` → 软链 `06:35:25.264` → `build-manifest.json` `06:35:27.730`，即首次
   evaluate 落在软链就位之前（约 5 ms 窗口）。
2. **Bun 缓存解析失败，Node 不缓存。** 同一目录、同一进程内：先 `require` 失败 → 建软链 →
   再 `require`，Bun 仍报 `Cannot find module`，Node 解析成功。所以那 5 ms 的竞态不是一次
   瞬时错误，而是把整个 dev 进程永久毒化：之后每个请求都 500，只有换进程能恢复。

证据：`/tmp/sforum-dev.log`（05:50 一轮）与 06:35 一轮是同一条失败；`rm -rf .next` 后必现；
而一个**全新** Bun 进程 require 同一个 chunk 是成功的——说明软链本身没问题，纯粹是进程内负缓存。

## 决定

`service/package.json` 的 `dev` 去掉 `--bun`：

```json
"dev": "next dev -p 4000"
```

`bun run <script>` 不带 `--bun` 时执行 `.bin` 里的 `#!/usr/bin/env node`（实测
`bun runtime: false | node: v26.10.0`），所以仍用 `bun run dev` 启动，只是进程是 Node。
Turbopack 保留，dev 与 build 用同一个 bundler。

`build` / `start` 保持 `bun --bun`：生产输出不走 dev 的别名软链机制（2026-10-25 复测见
`sessions/2026-10-25-dev-bun-turbopack-externals.md`）。

## 放弃的方案

- **`bun --bun next dev --webpack`**：webpack 的 externals 发真名 `require("postcss")`，而 Bun 的
  隔离安装只软链直接依赖（`service/node_modules` 里 32 条），`postcss` 是 `sanitize-html` 的
  传递依赖、不 hoist，从 `.next/server/chunks` 解析不到。要用它得先把 `postcss` 提为直接依赖，
  换来的还是一条更慢、且在 Next 16 里逐步退场的 dev 链路。
- **保持 Bun + Turbopack，靠「先跑一次再重启」绕过**：`rm -rf .next` 后必现，写成约定等于把
  一个必现故障包装成操作步骤。
- **改 `serverExternalPackages`**：该配置是追加语义，Next 默认表删不掉；别名带哈希，既不能预建
  也无法 alias。

## 代价与重开条件

代价：dev 不再跑 Bun 运行时，Bun 在 dev 路径上的问题不会在本地暴露；`next dev` 的启动与 HMR
回到 Node 基线（实测冷启动 `Ready in 490ms`，编译 `/`、`/api/health`、`/p/[slug]` 三页均 200）。

重开条件：Bun 修掉解析负缓存，或 Turbopack 把 external 改回真名。改回 `--bun` 前必须按
`sessions/2026-10-25-dev-bun-turbopack-externals.md` 的复现步骤（`rm -rf .next` 冷启动 + 一次
`/p/[slug]`）验证，不接受「这次没复现」。

# S2：GitHub App 客户端与 ZIP 检测的库选择

Status: accepted
Date: 2026-10-24

## 背景

S2 要签 GitHub App JWT、缓存 installation token、验 webhook、读 ZIP 内的清单与后端二进制、
流式算 SHA-256。需要决定哪些库自己做、哪些引进来；同时不能让 ZIP 处理变成内存炸弹或引入
原生依赖。

## 决定

- **GitHub 客户端自己写薄层**，只用 `node:crypto` 签 RS256 JWT；不引 Octokit。需要的能力只有
  installation、repositories、release、asset download 五个调用，薄层更小、更容易测。
- **installation token 进程内缓存**，到期前 60 秒刷新；不落库（token 是短命的，落库反而多一个
  泄露面）。
- **ZIP 读取用 `yauzl`**：流式、`validateEntrySizes`、entry 数量与总解压体积上限（2048 条 /
  50 MiB），不把整包读进内存。
- **测试写 ZIP 用 `yazl`**，只在 devDependencies；运行时不带写 ZIP 能力。
- **检测顺序**：Go `debug/buildinfo` 字符串 → ELF/Mach-O 头 → 文件名；每次写
  `detection_source`。主题固定 `any/any`。
- **webhook 只验签 + 幂等入队**；重活给 pg-boss worker，路由里不下载 ZIP。

## 放弃的方案

- **Octokit**：体积与抽象都超过当前五个调用的需要。
- **adm-zip / unzipSync**：整包解压，50 MiB 上限下仍可能被压缩炸弹拖垮。
- **把 ZIP 落对象存储**：违反「不存包体」；临时文件用完即删。
- **webhook 内同步下载**：GitHub 会因超时重试，且请求生命周期不可控。

## 代价与重开条件

- 薄客户端要自己跟 GitHub API 版本与错误形状；五个调用之外的需求出现时再评估 Octokit。
- 内存 token 缓存多实例不共享，每个实例各自换 token；可接受（GitHub 允许）。
- 文件名兜底会误判；因此 `detection_source` 必须展示，审核可覆盖。

# S3 依赖与存储：semver、file-type/image-size、本地内容寻址

Status: accepted
Date: 2026-10-24

## 背景

S3 要落公开目录（兼容过滤、分页、ETag）、签名下载与产品图片上传。这三件事各自需要一类
v1 尚未拥有的能力：**semver 约束求值**、**图片格式/尺寸判定**、**上传物的持久化与寻址**。
`decisions/2026-10-24-ui-stack.md` 要求新增依赖先写清「为什么是它、放弃了谁、什么条件下换」，
本文件一次把三项都钉住。

## 决定

### 1. `semver`（直接依赖 `^7`）

- `sforumVersion` 是 Masterminds 约束（计划 §2.1 事实 9），目录必须做**约束求值**而不是等值
  比较（Q6）。`semver` 的 `satisfies`/`valid` 是唯一成熟的 Node 侧实现，且已在依赖树里
  （`drizzle-kit` 传递依赖），提为直接依赖不增加体积。
- **兼容处理**：Masterminds 允许逗号分隔（`>=1.2.0, <2.0.0`），node-semver 不认；求值前把
  `,` 归一成空格。求值抛错 → 视为非法约束，该版本不进目录、不参与兼容判断（§7.3 第 10 条）。
- **已知偏差**：两者在 `||`、`^`、`~`、`x` 区间语义上一致；Masterminds 的 `!=`、`>= 1.2`
  宽松写法在 node-semver 下可能被拒。偏差只影响「商城是否展示」，core 安装时的
  `incompatible` 仍是最终裁判（计划 §5.7），因此可接受。
- 放弃：自己写约束解析器（语义边界多、无收益）；把求值推到 core（目录要能离线过滤）。

### 2. `file-type` + `image-size`（直接依赖）

- AGENTS「Stack」已指定这两者；本文件把它们与**判据顺序**固定下来：`file-type` 读魔数是
  唯一格式判据（不看扩展名、不看 `Content-Type`），`image-size` 只取宽高。
- `file-type@19` 是纯 ESM，Bun 与 Next 的 node runtime 都直接吃；实测 `fileTypeFromBuffer`
  与 `imageSize` 在本仓 Bun 下可用（2026-10-24）。
- **不引入 `sharp`**：v1 不做缩放/转码/裁切，只做「是否为安全位图」的准入。`sharp` 会带来
  原生依赖与构建矩阵风险，收益是 S3 不需要的能力。

### 3. 本地内容寻址存储（`src/lib/storage`）

- `assets.sha256` 唯一；磁盘键 `sha256[0:2]/sha256[2:4]/sha256`，根目录
  `STORE_ASSET_DIR`（默认 `service/.data/assets`，gitignored）。
- 只存图片；**不存 ZIP**（AGENTS 边界 3）。`release_assets` 仍只有摘要与尺寸，没有
  storage_key。
- 幂等：同内容重复上传复用同一行、不写第二个文件；读图走 `GET /api/assets/{sha256}` +
  `immutable` 长缓存。
- 预留 S3 适配器：接口做成 `put/read/exists` 三个方法，换对象存储时只换实现。
- 放弃：把图片塞进 Postgres（备份与流式读都变差）；直接写 `public/`（构建产物与运行时
  写入混在一起，容器只读根文件系统时会炸）。

### 4. 目录 ETag 与分页

- ETag = **响应体的 sha256**（规范化 JSON）。不做「查询参数指纹 + 版本号」的两段式：那需要
  额外的目录版本表与失效逻辑，而 v1 目录查询是廉价索引扫描。body-hash 天然满足「不同
  `sforum`/平台参数不得共享缓存」（§7.3 第 4 条）。
- 分页用 **keyset**（`updated_at desc, id desc`）的不透明 base64 cursor，不用 offset：
  offset 在并发同步下会重复/漏行。
- 放弃：`Last-Modified` 协商（产品行会批量更新，语义不如 ETag 直接）。

## 代价与重开条件

- body-hash ETag 每次请求都要算完整页，CPU 换正确性；目录量级上来（>10⁴ 产品）再评估
  「目录版本号 + 参数指纹」。
- node-semver 与 Masterminds 的边界偏差靠「core 是最终裁判」兜底；若出现商城显示兼容但 core
  拒绝的真实案例，再引入 Go 侧求值或约束白名单。
- 本地卷意味着单机；多副本部署前必须换对象存储或共享卷（S6 部署矩阵里写）。

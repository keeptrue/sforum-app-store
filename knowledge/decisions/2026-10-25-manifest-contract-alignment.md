# 清单契约对齐：宿主 schema 是唯一结构权威

Date: 2026-10-25
Status: accepted
Plan: `plans/2026-10-25-app-store-service.md`（S7 清单契约对齐）

## 背景

商城要判断「这个包能不能上架」，宿主在安装时要判断「这个包能不能装」。两边解析的是同一份
`sforum.extension.json`，但实现是两套：

- 宿主：`apps/api/app/Support/ExtensionManifest`，安装路径 `ReadArchive` → `LoadRootBytes`
  先跑 JSON Schema（`json_schema.go`），再跑语义 `Validate`，最后 `ValidatePackageFiles`。
- 商城：`service/src/lib/detection/manifest.ts`，手写 7 个字段、99 行。

对照后共有 14 处双向漂移。最典型的两类：

1. **商城拒、宿主收**：id 上限 64（宿主 81）、`1.0.0+build` 被当成非 semver、ZIP 条目上限
   2048（宿主 4096）。
2. **商城收、宿主拒**：清单可以在一层子目录（宿主只认根）、缺 `description`/`url`/`author.name`、
   backend 缺 `rpc`/`digest`、未知字段被忽略（宿主 schema 是 `additionalProperties: false`）。

结果不是「显示得不够好」，而是目录里出现装不上的包，或者合法扩展根本进不了目录。另外
`sforumVersion` 用 node-semver 解析，`!=` 被当成非法约束，导致该版本在公开读里静默消失。

## 决定

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **vendor 宿主 JSON Schema**：`service/src/lib/detection/schema/manifest-v3.schema.json` 是宿主文件的逐字节副本，配 `manifest-v3.lock.json`（commit + sha256）与 `manifest:sync` / `manifest:check` | 宿主安装时确实跑这份 schema，它是「必要且同源」的一刀；手写子集必然漂移 |
| D2 | **只补语义差量**：id/version/type 归一化、必填与 URL、backend 四元组、主题禁声明、`requiresFeatures`、`packageFiles` | 这些是宿主必拒、商城又能廉价判断的规则；不搬 13.5k 行 V3 语义校验器（routes/hooks/database 商城不执行） |
| D3 | **归档边界照 `ReadArchive`**：清单必须在 ZIP 根、4096 条目、拒绝 symlink/重复条目/含 `..` 的路径 | 「商城收、宿主拒」的包直接不进目录，而不是等管理员安装时才发现 |
| D4 | **`packageFiles` 逐文件核对摘要** | 宿主 `ValidatePackageFiles` 会核对；商城手上有 ZIP，同样的判断不需要额外成本 |
| D5 | **约束解析补 Masterminds 语义**：`,` 与 `!=` 都支持，`!=` 作为排除集保留 | 商城是唯一求值方；把宿主认可的约束判成非法，等于让版本消失 |
| D6 | **清单元数据落库并展示**：`release_versions.manifest_description/url/author_name/author_url/langs` | 审核员与访客看到的就是宿主会展示的文案；author email 校验后丢弃，不落库、不出现在 API |
| D7 | **双跑一致性夹具**：`test/fixtures/manifest` + `manifest:conformance`，`--host` 用宿主 `validate-manifest` 对拍 | 防漂移不能靠注释；同一批 fixture 两边 verdict 必须一致 |

### 与「产品身份单源化」的关系

`2026-10-25-github-only-product-identity.md` 定的是**身份**：名称取自清单 `name`，介绍取自
README，图标取自社交预览，没有第二份长文案。D6 不改变这条：

- 清单 `description` 是一行宿主展示文案，落库后只作为「清单简介」原样透出，README 仍是唯一长文；
- `author`/`url`/`langs` 是来源元数据，不是产品文案，不参与审核快照；
- 产品名、摘要、图标的来源不变。

## 放弃的方案

- **把宿主 13.5k 行 V3 校验器搬进 TS**：两份实现长期漂移，且商城不执行 routes/hooks/database，
  搬过来只是把宿主的复杂度复制一份。
- **同步时调用宿主校验**：商城不调论坛内部接口，也没有「同步时一定有个宿主在线」的前提。
- **按宿主 capabilities 目录硬拒未知键**：目录比商城同步频率高，陈旧目录会误拒合法扩展；
  误拒的代价（扩展进不了目录）比误收（安装时被宿主拒）更高。因此只做 trim/去重/排序 + 原样展示。
- **保留一层子目录清单**：GitHub release 里常见的 `zip -r dir/` 打包方式宿主装不上，商城继续
  接受只会制造「上架了但装不上」。

## 代价与重开条件

- **schema 需要手动同步**：宿主改 schema 后要跑 `bun run manifest:sync -- --sforum <path>`；
  `manifest:check` 只保证 vendored 文件没被手改，不保证与上游最新一致。CI 可加 `--host` 对拍，
  但默认不依赖 SForum 检出。
- **残余差异**（写在 `docs/developer.md` 与实现注释里，重开条件也在这里）：
  - `sforum-route-mutable-*` 两个自定义 format 注册为宽松：用到指针预算的清单商城可能收、宿主拒。
    宿主 `route_mutable_fields.go` 的预算实现若稳定下来，再决定是否移植。
  - `includes` 合并后的第二次 schema 校验不跑（商城只校验根文档）。
  - capabilities 不按宿主目录硬拒。
  - 单清单 1 MiB 上限保留（宿主只受 50 MiB 总量约束）。
  - 已发布历史版本不回溯重判：收紧规则只影响之后同步的版本。
- **新增依赖** `ajv` + `ajv-formats`：只为跑这份 schema。若 Next/Bun 运行时对 ajv 的 Draft
  2020-12 支持出问题，回退方案是只校验顶层契约（required/type/additionalProperties）——
  代价是嵌套字段漂移重新出现。

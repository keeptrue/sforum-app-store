# Glossary

| 术语 | 含义 | 不要混淆 |
| --- | --- | --- |
| issuer | 一个 SForum 论坛的 OAuth2 提供方标识（站点基址） | 不是「商城」本身 |
| sub | provider 签发的用户标识，只在单个 issuer 内稳定 | 不是全局用户 ID |
| account | 商城账号，唯一键 `(issuer, sub)` | 不等于论坛用户 |
| extension_id | 扩展清单里的 `id`（如 `sforum.store`），跨仓库全局唯一 | 不等于 repo 名，也不等于 slug |
| product | 商城里的一个上架条目，绑定一个 `extension_id` | 一个仓库可以有多个 product |
| repo_release | 仓库的一个 release tag（GitHub 概念，S 组的聚合单位） | 不等于扩展版本 |
| release_version | 某个 product 在一个 repo_release 下的一个版本 | 版本以 manifest 为准 |
| release_asset | 某个 release_version 的一个 ZIP（按 os/arch 或 any/any） | 一个 ZIP 只含一个扩展 |
| upstream_state | 上游连通性：connected / degraded / disconnected | 不要与 `status` 混用 |
| detection_source | 平台判定来源：buildinfo / header / filename | 兜底必须记录 |
| intent | SForum core 的安装意图（`extinst_…`） | 不是商城自己的任务 |
| staged | 意图终态：包已暂存待信任/启用 | 不等于已安装、已启用 |
| signed download token | 商城签发的下载凭据，含 asset id / sha256 / exp | 不是 GitHub 直链 |
| channel | stable / beta | beta 默认不进目录 |
| needs_attention | 自动检测无法定论，等人审 | 不是失败，也不能自动通过 |

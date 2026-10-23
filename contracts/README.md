# contracts

`store-api.yaml` 是两个产物之间**唯一**的共享契约。S0 落地。

## 规则

- 契约先行：改 API 先改 yaml，再改实现；不允许「实现改了契约没跟上」的提交。
- 生成物：`openapi-typescript` 出 TS 类型给 `service/` 与插件前端；`oapi-codegen` 出 Go client
  给 `plugin/`。生成代码进仓库但标注 generated，不手改。
- 版本：路径带 `/api/v1`；破坏性变更开 `/api/v2`，不原地改语义。
- 错误体统一 `{code, message, details}`；`code` 是稳定标识，供插件映射文案，`message` 只给人看。
- 公开读接口必须有 `ETag` 与 `Cache-Control`；写接口不许出现在公开契约里。
- 插件专用的调用面（安装/状态）**不在本契约里**：那是 SForum core 的命令，见只读伴生计划
  §6.2。

## 待办

- `store-api.yaml` 的路径清单见任务书 §5.7。
- 契约里不得出现 GitHub 原始下载地址；`downloadUrl` 只能是商城签名短链。

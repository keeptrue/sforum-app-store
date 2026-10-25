import type { ApiFailure } from "@/components/dashboard/api";

/**
 * API error code → the sentence a developer can act on. Unknown codes fall back to the
 * server's own message, so a new code is never silently swallowed.
 */
const COPY: Record<string, string> = {
  unauthenticated: "登录已过期，请重新登录后再试。",
  cross_origin: "请求不是来自商城页面，已被拒绝；刷新页面重试。",
  network_error: "网络请求失败，请检查连接后重试。",
  internal_error: "服务端出错了，稍后重试；这次修改没有生效。",
  config_error: "服务端配置不完整，联系部署者。",

  product_not_found: "找不到这个产品，或它不属于当前账号。",
  version_not_found: "找不到这个版本，或它不属于当前账号。",
  manual_create_disabled:
    "手动创建已关闭：产品只能从 GitHub 仓库导入，名称与介绍都取自仓库。",
  readme_unavailable: "还没有读到这个仓库的 README，先绑定仓库并重新拉取一次。",
  extension_id_taken: "这个扩展 ID 已被占用；它跨仓库全局唯一，冲突由审核裁决。",
  slug_taken: "短链标识已被占用，换一个名称再试。",
  invalid_extension_id: "扩展 ID 不合法：小写字母或数字开头，3–64 位，可用 . _ -。",
  invalid_name: "名称不能为空，且不超过 200 字。",
  invalid_category: "分类不在可选范围内，请从下拉列表里选。",
  invalid_tags: "标签不合法：最多 10 个，每个不超过 32 字，不能为空。",
  invalid_locale: "默认语言不合法，例如 zh-CN。",
  invalid_slug: "短链标识不合法：小写字母或数字开头，2–64 位，可用 -。",
  text_too_long: "文本超过长度上限，请删减后再保存。",
  field_not_editable: "这个字段不能在这里修改。",
  invalid_body: "请求内容无法解析，刷新页面后重试。",
  invalid_json: "请求内容无法解析，刷新页面后重试。",

  invalid_state: "当前状态不支持这个操作。",
  no_reviewable_version: "没有可审版本：需要 candidate 或 pending_review 状态的版本。",
  missing_copy: "默认语言的名称或摘要为空，先补齐文案再提交。",
  invalid_reason: "理由必须是 1–500 字。",

  github_not_configured: "这个部署没有配置 GitHub App，仓库功能不可用。",
  invalid_repo_id: "仓库参数不合法，刷新页面后重试。",
  invalid_installation_id: "GitHub 安装参数不合法，刷新页面后重试。",
  installation_not_found: "找不到这个 GitHub 安装，或它不属于当前账号。",
  installation_suspended: "这个 GitHub 安装已被暂停，先在 GitHub 上恢复再试。",
  installation_repo_limit: "安装覆盖的仓库过多，超出了商城一次能镜像的范围。",
  repo_not_bindable: "找不到这个仓库，或它不在当前账号的 GitHub 安装范围内。",
  repo_archived: "仓库已归档，不能再接收新 release；先在 GitHub 上取消归档。",
  repo_binding_locked: "已发布的产品不能解绑仓库；换一个仓库可以，但会重新进入审核。",
  repo_has_no_release: "这个仓库还没有正式 release，先发一个带 ZIP 的 release。",
  repo_release_has_no_zip: "最新 release 里没有 ZIP 资产，商城只同步 ZIP。",
  repo_unknown: "同步时找不到仓库记录，稍后重试或重新连接 GitHub。",
  extension_id_bound_elsewhere: "这个扩展 ID 已绑定到另一个仓库，冲突由审核裁决。",
  claim_not_found: "这条待认领记录已经处理过，或不属于当前账号。",
  claim_already_settled: "这条记录刚被处理过了，刷新页面看最新状态。",
  product_unclaimed: "release 里的扩展 ID 还没有对应产品，已进入待认领。",
  repo_bind_pending: "产品还没绑定仓库，先在产品页绑定这个仓库。",
  repo_mismatch: "扩展 ID 属于另一个仓库，版本不会跨仓库写入。",
};

export function messageFor(failure: ApiFailure): string {
  const known = COPY[failure.code];
  if (known) return known;
  if (failure.message) return failure.message;
  return failure.status > 0 ? `请求失败（HTTP ${failure.status}）。` : "请求失败。";
}

// 商城管理页的深链参数：`?product=<slug>` 由 Core 的扩展行徽章链接过来。
//
// 只读不写：这里不碰 history、不改卡片点击的 URL，也不做任何跳转 —— 页面挂载时
// 读一次，合法就打开现有详情弹窗，非法就当没这个参数。
//
// slug 规则与商城后端一致：`^[a-z0-9][a-z0-9-]{1,63}$`。大小写、下划线、前导
// 连字符都不放过，避免把「看起来像 slug」的输入变成一次后端 404。
const PRODUCT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function readProductQuery(search: string): string {
  if (typeof search !== "string" || search === "") return "";
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const slug = (params.get("product") ?? "").trim();
    return PRODUCT_SLUG_PATTERN.test(slug) ? slug : "";
  } catch {
    // URLSearchParams 对畸形百分号是宽容的；这里只是兜住宿主传入的异常值。
    return "";
  }
}

"use client";

import { toast } from "sonner";

/**
 * Copy a digest and say so. Shared by the product page and the install dialog so the
 * success/failure wording cannot drift between the two places a digest is shown.
 */
export function copyDigest(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    toast.error("当前环境无法访问剪贴板");
    return;
  }
  navigator.clipboard.writeText(value).then(
    () => toast.success("SHA-256 已复制"),
    () => toast.error("复制失败，请手动选取"),
  );
}

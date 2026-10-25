"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ImageOff, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { jsonRequest } from "@/components/dashboard/api";
import {
  BRAND_SOURCE_LABELS,
  describeBrandCode,
  formatDateTime,
} from "@/components/dashboard/labels";
import { messageFor } from "@/components/dashboard/messages";
import type { DashboardProductDetail } from "@/lib/products/types";

/** `sha256` is 64 hex chars; the first 12 are what a person can compare by eye. */
const SHA_PREVIEW = 12;

type BrandRefreshResponse = {
  icon: {
    ok: boolean;
    source: "brand_icon" | "social_preview" | null;
    sha256: string | null;
    fetchedAt: string | null;
    note: string | null;
    reason: string | null;
    changed: boolean;
  };
  social: {
    ok: boolean;
    sha256: string | null;
    fetchedAt: string | null;
    reason: string | null;
    changed: boolean;
  };
};

/**
 * The two brand files, and the only button that re-reads them on demand.
 *
 * Read-only by construction: the pictures live in the repository, so there is nothing to
 * upload or edit here. What the panel adds over the header mark is provenance — which file
 * produced the picture, when it was read, and *why the brand file was skipped* when the mark
 * on screen came from the social-preview fallback. That last part used to be silent: the
 * README button refreshed the mark and discarded the result, so a rejected `brand/icon.png`
 * looked exactly like a repository that never had one.
 */
export function BrandPanel({ product }: { product: DashboardProductDetail }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { icon, social } = product.brand;
  const unbound = product.repoId === null;

  async function refresh() {
    setPending(true);
    setError(null);
    const result = await jsonRequest<BrandRefreshResponse>(
      `/api/dashboard/products/${product.id}/brand/refresh`,
      "POST",
    );
    setPending(false);
    if (!result.ok) {
      setError(messageFor(result.failure));
      return;
    }
    if (result.data.icon.ok || result.data.social.ok) {
      toast.success(
        result.data.icon.changed || result.data.social.changed
          ? "品牌图已更新"
          : "品牌图已是最新",
      );
    } else {
      // A failed refresh keeps the previous pictures; the reason is read back from the row
      // this request just wrote, so it stays visible after the page repaints.
      setError(describeBrandCode(result.data.icon.reason));
    }
    router.refresh();
  }

  const note = describeBrandCode(icon.note);
  const iconError = describeBrandCode(icon.error);
  const socialError = describeBrandCode(social.error);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>品牌图</CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || unbound}
            onClick={() => void refresh()}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            刷新品牌图
          </Button>
        </div>
        <CardDescription>
          图标取自扩展包目录里的 <code className="font-mono">brand/icon.png</code>（与{" "}
          <code className="font-mono">sforum.extension.json</code> 同级，方形 PNG，≤1 MiB），
          没有就用 GitHub 社交预览；分享卡取自同目录的{" "}
          <code className="font-mono">brand/social-preview.png</code>。图在仓库里，这里不提供上传。
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {unbound ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            产品还没有绑定仓库。绑定之后商城才能读到仓库里的品牌图。
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-4">
          <div className="grid size-[88px] shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-muted">
            {icon.url ? (
              <img
                src={icon.url}
                alt=""
                width={88}
                height={88}
                className="size-full object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="text-[28px] font-semibold text-muted-foreground"
              >
                {product.name.trim().slice(0, 1) || "?"}
              </span>
            )}
          </div>

          <dl className="flex min-w-0 flex-1 flex-col gap-1.5 text-[12.5px]">
            <BrandField
              label="来源"
              value={brandSourceLabel(icon.source, icon.url)}
              mono={icon.source === "brand_icon"}
            />
            <BrandField
              label="抓取于"
              value={icon.fetchedAt ? formatDateTime(icon.fetchedAt) : "从未"}
            />
            <BrandField
              label="sha256"
              value={icon.sha256 ? icon.sha256.slice(0, SHA_PREVIEW) : "—"}
              mono
            />
          </dl>
        </div>

        {note ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-[12.5px] leading-relaxed">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 break-words">{note}</span>
          </p>
        ) : null}

        {iconError ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-[12.5px] leading-relaxed">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 break-words">上次刷新失败：{iconError}</span>
          </p>
        ) : null}

        <div className="surface-quiet flex flex-wrap items-center gap-3 px-3 py-2.5">
          <div className="grid h-[52px] w-[104px] shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted">
            {social.url ? (
              <img
                src={social.url}
                alt=""
                width={104}
                height={52}
                className="size-full object-cover"
              />
            ) : (
              <ImageOff className="size-4 text-muted-foreground" aria-hidden />
            )}
          </div>
          <div className="min-w-0 text-[12.5px] leading-relaxed">
            <p className="font-medium">分享卡</p>
            <p className="text-muted-foreground">
              {social.url
                ? `brand/social-preview.png · ${social.fetchedAt ? formatDateTime(social.fetchedAt) : "—"}`
                : "仓库里还没有 brand/social-preview.png，产品页的链接预览会用默认图。"}
            </p>
            {socialError ? (
              <p className="text-muted-foreground">{socialError}</p>
            ) : null}
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[13px] leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A row fetched before the brand pipeline existed has a mark but no `source`. Saying "no icon"
 * there would contradict the picture right next to it.
 */
function brandSourceLabel(
  source: "brand_icon" | "social_preview" | null,
  url: string | null,
): string {
  if (source) return BRAND_SOURCE_LABELS[source];
  if (url) return "旧记录（抓取来源未记录）";
  return "还没有图标（卡片显示字母块）";
}

function BrandField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="w-[52px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

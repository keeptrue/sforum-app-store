import Link from "next/link";
import { ArrowUpRight, ExternalLink, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductMark } from "@/components/storefront/product-mark";
import {
  KIND_LABELS,
  STATUS_HINTS,
  STATUS_LABELS,
  STATUS_TONES,
  formatDateTime,
} from "@/components/dashboard/labels";
import type { VersionSummary } from "@/lib/products/version-summary";
import type { DashboardProduct } from "@/lib/products/types";

export type ProductRow = {
  product: DashboardProduct;
  latest: VersionSummary | null;
  versionCount: number;
};

/**
 * One row per product. Built from flex wrapping rather than a table: on a 390px viewport the
 * identity block and the evidence stack (latest version, counters, actions) wrap onto separate
 * lines, which keeps the page free of horizontal scroll. Rows are flat until hovered.
 */
export function ProductList({ rows }: { rows: ProductRow[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map(({ product, latest, versionCount }) => {
        const editorHref = `/dashboard/products/${product.id}`;
        const published = product.status === "published";
        return (
          <li
            key={product.id}
            className="flex flex-wrap items-start gap-3 surface p-3.5 transition-colors hover:border-input"
          >
            <ProductMark
              name={product.name}
              kind={product.kind}
              iconUrl={product.previewUrl}
            />

            <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={editorHref}
                  className="truncate text-sm font-medium underline-offset-4 hover:underline"
                >
                  {product.name}
                </Link>
                <Badge variant={STATUS_TONES[product.status]}>
                  {STATUS_LABELS[product.status]}
                </Badge>
                <Badge variant="outline">{KIND_LABELS[product.kind]}</Badge>
              </div>

              <div className="font-mono text-[12.5px] break-all text-muted-foreground">
                {product.extensionId}
              </div>

              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {STATUS_HINTS[product.status]}
              </p>
              {product.reviewReason ? (
                <p className="text-[13px] leading-relaxed break-words text-destructive">
                  拒绝原因：{product.reviewReason}
                </p>
              ) : null}
            </div>

            <div className="flex w-full flex-row items-end justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:gap-2.5 sm:pl-2">
              <div className="text-left sm:text-right">
                <div className="flex items-baseline gap-1.5 sm:justify-end">
                  <span className="text-[12px] text-muted-foreground">最新</span>
                  <span className="font-display text-lg font-semibold tracking-tight">
                    {latest ? latest.version : "—"}
                  </span>
                  {latest && !latest.published ? (
                    <span className="text-[12px] text-muted-foreground">
                      （未发布）
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                  <span className="tabular-nums">
                    {versionCount > 0 ? `${versionCount} 个版本` : "还没有版本"}
                  </span>
                  <span title={product.updatedAt}>
                    {" · "}更新于 {formatDateTime(product.updatedAt)}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {published ? (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/p/${product.slug}`}>
                        <ExternalLink aria-hidden />
                        查看
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={editorHref}>
                        <Pencil aria-hidden />
                        编辑
                      </Link>
                    </Button>
                  </>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link href={editorHref}>
                      <ArrowUpRight aria-hidden />
                      {product.status === "pending_review" ? "查看进度" : "继续编辑"}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

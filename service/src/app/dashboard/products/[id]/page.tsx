import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductMark } from "@/components/storefront/product-mark";
import { BrandPanel } from "@/components/dashboard/brand-panel";
import { CopyEditor } from "@/components/dashboard/copy-editor";
import { RepoBindingPanel } from "@/components/dashboard/repo-binding-panel";
import { ReadmePanel } from "@/components/dashboard/readme-panel";
import { ReviewPanel } from "@/components/dashboard/review-panel";
import { VersionsTable } from "@/components/dashboard/versions-table";
import {
  KIND_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  formatDateTime,
} from "@/components/dashboard/labels";
import { requireDashboardSession } from "@/components/dashboard/session";
import { getDb } from "@/db/client";
import { loadRepoBinding } from "@/lib/products/binding";
import { getDashboardProduct } from "@/lib/products/service";
import { categoryLabel } from "@/lib/products/taxonomy";
import type { DashboardProductDetail } from "@/lib/products/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "产品编辑" };

export default async function DashboardProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireDashboardSession();
  const { id } = await params;

  const db = getDb();
  let product: DashboardProductDetail;
  try {
    product = await getDashboardProduct(db, {
      accountId: session.account.id,
      productId: id,
    });
  } catch {
    // Someone else's product must be indistinguishable from a missing one.
    notFound();
  }

  // The binding panel needs the repository row (name, upstream state, install account),
  // which the product DTO deliberately does not carry.
  const binding =
    product.repoId === null ? null : await loadRepoBinding(db, product.repoId);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pb-16 pt-7">
      <PageHeader
        leading={
          <ProductMark
            name={product.name}
            kind={product.kind}
            iconUrl={product.previewUrl}
            size="lg"
          />
        }
        title={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {product.name}
            <Badge variant={STATUS_TONES[product.status]}>
              {STATUS_LABELS[product.status]}
            </Badge>
            <Badge variant="outline">{KIND_LABELS[product.kind]}</Badge>
          </span>
        }
        meta={
          <>
            <span className="font-mono break-all">{product.extensionId}</span>
            <span>分类 {categoryLabel(product.category) ?? "未指定"}</span>
            <span title={product.updatedAt}>
              更新于 {formatDateTime(product.updatedAt)}
            </span>
          </>
        }
        actions={
          <>
            <Button asChild size="sm" variant="ghost">
              <Link href="/dashboard">
                <ArrowLeft aria-hidden />
                我的产品
              </Link>
            </Button>
            {product.status === "published" ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/p/${product.slug}`}>
                  <ExternalLink aria-hidden />
                  公开页
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {/* Two columns on desktop, one column below lg — 390px must not scroll sideways. */}
      {/* `grid-cols-1` is not decoration: an implicit `auto` column is sized by min-content,
          and a README with a wide table or a long URL would push the whole page sideways at
          390px. `minmax(0,1fr)` lets the column shrink and the `.readme` block scroll instead. */}
      <div className="grid grid-cols-1 items-start gap-5 pt-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <BrandPanel product={product} />
          <CopyEditor product={product} />
          <ReadmePanel product={product} />
          <VersionsTable versions={product.versions} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <RepoBindingPanel product={product} binding={binding} />
          <ReviewPanel product={product} />
        </div>
      </div>
    </div>
  );
}

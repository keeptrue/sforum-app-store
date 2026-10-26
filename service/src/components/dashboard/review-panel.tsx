import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SubmitReviewButton } from "@/components/dashboard/submit-review-button";
import {
  STATUS_HINTS,
  STATUS_LABELS,
  STATUS_TONES,
  SYNC_STATE_LABELS,
  SYNC_STATE_TONES,
  VERSION_STATE_LABELS,
  VERSION_STATE_TONES,
  formatDateTime,
  isReviewable,
} from "@/components/dashboard/labels";
import type { DashboardProductDetail } from "@/lib/products/types";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="text-[12.5px] break-words text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Review state, the snapshot a moderator actually approved, and the one action a developer can
 * take. The latest rejection reason comes from `DashboardProductDetail.reviewReason`, so a
 * developer reads what the moderator actually wrote instead of guessing from a status badge.
 */
export function ReviewPanel({ product }: { product: DashboardProductDetail }) {
  const reviewable = product.versions.filter(isReviewable);
  const pending = product.status === "pending_review";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>审核</CardTitle>
          <Badge variant={STATUS_TONES[product.status]}>
            {STATUS_LABELS[product.status]}
          </Badge>
        </div>
        <CardDescription>{STATUS_HINTS[product.status]}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {product.reviewReason ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
            <div className="text-[12.5px] font-medium text-destructive">最近一次拒绝原因</div>
            <p className="mt-1 text-[13px] leading-relaxed break-words text-foreground">
              {product.reviewReason}
            </p>
          </div>
        ) : null}

        <dl className="grid gap-2.5">
          <Field label="首次发布">
            {product.publishedAt ? formatDateTime(product.publishedAt) : "尚未发布"}
          </Field>
          <Field label="最近同步">
            {product.sync === null ? (
              <span className="text-muted-foreground">还没有 release</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono">{product.sync.tag}</span>
                <span>
                  {product.sync.lastSyncedAt
                    ? formatDateTime(product.sync.lastSyncedAt)
                    : "尚未完成"}
                </span>
                <Badge variant={SYNC_STATE_TONES[product.sync.state]}>
                  {SYNC_STATE_LABELS[product.sync.state]}
                </Badge>
              </span>
            )}
          </Field>
          <Field label="审核快照 · 名称">
            {product.nameAtReview ?? "—（未审核过）"}
          </Field>
          <Field label="审核快照 · 仓库 ID">
            <span className="font-mono">
              {product.repoIdReviewed === null ? "—" : product.repoIdReviewed}
            </span>
            {product.repoId !== null ? (
              <span className="ml-1 text-muted-foreground">
                （当前 {product.repoId}）
              </span>
            ) : null}
          </Field>
          <Field label="已批准能力">
            {product.capabilitiesReviewed.length === 0 ? (
              <span className="text-muted-foreground">无</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {product.capabilitiesReviewed.map((capability) => (
                  <span
                    key={capability}
                    className="rounded border border-border px-1 py-0.5 font-mono text-[12px] text-muted-foreground"
                  >
                    {capability}
                  </span>
                ))}
              </span>
            )}
          </Field>
        </dl>

        {product.sync?.error ? (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
            <div className="text-[12.5px] font-medium text-warning">最近一次同步问题</div>
            <p className="mt-1 text-[13px] leading-relaxed break-words text-foreground">
              {product.sync.error}
            </p>
          </div>
        ) : null}

        <div className="grid gap-2 border-t border-border pt-3">
          <span className="text-xs font-medium">可审版本</span>
          {reviewable.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              没有 candidate / pending_review 状态的版本。同步一个 GitHub release 后才会出现。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {reviewable.map((version) => (
                <li key={version.id} className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px]">{version.version}</span>
                  <Badge variant={VERSION_STATE_TONES[version.state]}>
                    {VERSION_STATE_LABELS[version.state]}
                  </Badge>
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {version.channel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <SubmitReviewButton
            productId={product.id}
            status={product.status}
            reviewableCount={reviewable.length}
          />
        </div>

        <div className="grid gap-1 border-t border-border pt-3">
          <span className="text-xs font-medium">审核规则</span>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            首个版本由人工审核。产品通过审核后，之后的版本在四件事不变时自动发布：能力集合没有
            新增、产品没有改名、仓库没有更换、并且已有审核快照；任何一项变化都会让版本回到人工
            审核。
          </p>
          {pending ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              当前正在人工审核：上面就是审核对照的快照。获批后这些能力键会被记入产品，后续版本
              只带这些键时直接发布。
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

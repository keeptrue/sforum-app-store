import { Suspense, type ReactNode } from "react";
import { ExternalLink, GitBranch, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ReadmeContent } from "@/components/readme/readme-content";
import type { ReviewWorkflowHint } from "@/lib/github/actions";
import type { ModerationProductDetail } from "@/lib/moderation/types";

import { ProductActions } from "./actions/product-actions";
import { CapabilityDiff } from "./capability-diff";
import { ConsoleSection } from "./console-section";
import { EventTimeline } from "./event-timeline";
import {
  diffCapabilities,
  formatAgo,
  kindLabel,
  productStatusLabel,
  productStatusTone,
  repoUrl,
} from "./format";
import { VersionTable } from "./version-table";
import { WorkflowHintSlot } from "./workflow-hint";

/**
 * Right pane: everything a moderator needs to decide. The capability diff and the rename
 * flag explain *why* the subject is here; approve/reject live in the header (product) and in
 * the version table (single version). The GitHub Actions strip is a hint only — it is
 * streamed in behind Suspense and disappears entirely when GitHub has nothing to say.
 */
export function DetailPanel({
  detail,
  focusedVersionId,
  now,
  workflowHint,
}: {
  detail: ModerationProductDetail;
  focusedVersionId: string | null;
  now: number;
  /** Optional: the page starts this fetch; a missing promise renders no strip at all. */
  workflowHint?: Promise<ReviewWorkflowHint | null> | null;
}) {
  const { product } = detail;
  const approved = detail.capabilitiesReviewed;
  const firstReview = detail.nameAtReview === null;
  const held = detail.versions.filter((version) => version.state === "pending_review");
  const focus =
    detail.versions.find((version) => version.id === focusedVersionId) ??
    held[0] ??
    detail.versions[0] ??
    null;
  const focusDiff = focus ? diffCapabilities(approved, focus.capabilities) : null;
  // The "why is this here" banner describes the decision in front of the reviewer: the
  // held version they selected, otherwise the first one still waiting.
  const bannerVersion = focus?.state === "pending_review" ? focus : held[0] ?? null;
  const bannerDiff = bannerVersion
    ? diffCapabilities(approved, bannerVersion.capabilities)
    : null;
  const newKeys = firstReview ? [] : (bannerDiff?.added ?? []);
  const link = repoUrl(detail.repoFullName);
  // `productRenamed` is `name !== name_at_review`, which is trivially true with no snapshot.
  // A first review is not a rename.
  const renamed = detail.productRenamed && detail.nameAtReview !== null;

  const reasons: string[] = [];
  if (firstReview) {
    reasons.push("该产品还没有通过过审核，这是首次人工确认。");
  }
  if (renamed && detail.nameAtReview) {
    reasons.push(
      `产品名在通过审核后改成了「${product.name}」（原名「${detail.nameAtReview}」），需要重新确认。`,
    );
  }
  if (newKeys.length > 0 && bannerVersion) {
    reasons.push(
      `版本 ${bannerVersion.version} 声明了未审过的能力：${newKeys.join("、")}。`,
    );
  }

  return (
    <article className="flex min-h-0 flex-col md:h-full">
      <header className="border-b border-border px-4 pb-3 pt-4 md:px-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="text-lg font-display font-semibold tracking-tight">
                {product.name}
              </h2>
              <Badge variant="outline">{kindLabel(product.kind)}</Badge>
              <Badge variant={productStatusTone(product.status)}>
                {productStatusLabel(product.status)}
              </Badge>
              {renamed && <Badge variant="warning">已改名</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-[12.5px] text-muted-foreground">
              <span>{product.extensionId}</span>
              <span aria-hidden>/</span>
              <span>{product.slug}</span>
            </div>
          </div>
          <ProductActions product={product} />
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Meta term="提交人">
            <span className="block truncate">{detail.submittedBy ?? "未知"}</span>
          </Meta>
          <Meta term="提交时间">
            {detail.submittedAt ? (
              <span className="block truncate" title={detail.submittedAt}>
                {formatAgo(detail.submittedAt, now)}
              </span>
            ) : (
              <span className="block truncate text-muted-foreground">—</span>
            )}
          </Meta>
          <Meta term="首次发布">
            {detail.publishedAt ? (
              <span className="block truncate" title={detail.publishedAt}>
                {formatAgo(detail.publishedAt, now)}
              </span>
            ) : (
              <span className="block truncate text-muted-foreground">尚未发布</span>
            )}
          </Meta>
          <Meta term="仓库">
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="relative inline-flex max-w-full items-center gap-1 hover:underline"
                title={detail.repoFullName ?? undefined}
              >
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{detail.repoFullName}</span>
                <span className="sr-only">（在新窗口打开）</span>
              </a>
            ) : (
              <span className="block truncate text-muted-foreground">未绑定仓库</span>
            )}
          </Meta>
        </dl>
      </header>

      <div className="scrollbar-thin relative min-h-0 md:flex-1 md:overflow-y-auto">
        {reasons.length > 0 ? (
          <div className="border-b border-border bg-warning/5 px-4 py-3 md:px-5">
            <div className="flex items-start gap-2">
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0 text-warning"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  为什么需要人工审核
                </p>
                <ul className="mt-1 space-y-0.5 text-[13px] leading-relaxed text-muted-foreground">
                  {reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        {/* Streaming, not blocking: the console paints first, the hint fills in (or not). */}
        {workflowHint ? (
          <Suspense fallback={null}>
            <WorkflowHintSlot hint={workflowHint} />
          </Suspense>
        ) : null}

        <ConsoleSection
          title="介绍"
          hint={detail.readme ? detail.readme.path : undefined}
        >
          {detail.summary.trim() ? (
            <p className="mb-2 text-xs font-medium text-foreground">{detail.summary}</p>
          ) : null}

          {detail.readme ? (
            <>
              <details>
                <summary className="cursor-pointer text-[12.5px] text-muted-foreground hover:text-foreground">
                  展开 README 预览
                </summary>
                <ReadmeContent
                  className="readme surface-quiet mt-2 max-h-80 overflow-auto px-3 py-2.5"
                  html={detail.readme.html}
                />
              </details>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                <span className="font-mono">
                  {detail.readme.blobSha ? detail.readme.blobSha.slice(0, 12) : "—"}
                </span>
                <span aria-hidden>·</span>
                <span title={detail.readme.fetchedAt}>
                  拉取于 {formatAgo(detail.readme.fetchedAt, now)}
                </span>
                {detail.readme.sourceUrl ? (
                  <a
                    href={detail.readme.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                  >
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                    在 GitHub 查看
                    <span className="sr-only">（在新窗口打开）</span>
                  </a>
                ) : null}
              </p>
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted-foreground">
              还没有读取到这个仓库的 README；审核只能依据摘要与清单。
            </p>
          )}

          <p className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
            README 由仓库实时提供，审核只覆盖摘要与清单；README 变更会记入审计。
          </p>
        </ConsoleSection>

        <ConsoleSection
          title="版本"
          hint={`共 ${detail.versions.length} 个 · ${held.length} 个等审`}
        >
          <VersionTable
            versions={detail.versions}
            approved={approved}
            productName={product.name}
            firstReview={firstReview}
            focusedVersionId={focus?.id ?? null}
            now={now}
          />
        </ConsoleSection>

        <ConsoleSection
          title="能力变化"
          hint={focus ? `对照 ${focus.version}` : undefined}
        >
          <CapabilityDiff version={focus} approved={approved} firstReview={firstReview} />
        </ConsoleSection>

        <ConsoleSection title="事件" hint={`${detail.events.length} 条`}>
          <EventTimeline events={detail.events} now={now} />
        </ConsoleSection>
      </div>
    </article>
  );
}

function Meta({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 min-w-0 text-xs">{children}</dd>
    </div>
  );
}

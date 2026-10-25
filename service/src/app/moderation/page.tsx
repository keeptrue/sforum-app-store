import type { Metadata } from "next";

import { PageHeader } from "@/components/common/page-header";
import { Stat } from "@/components/common/stat";
import { DetailPanel } from "@/components/moderation/detail-panel";
import { DetailEmpty, DetailMissing } from "@/components/moderation/detail-states";
import { ModerationShell } from "@/components/moderation/moderation-shell";
import { QueuePanel } from "@/components/moderation/queue-panel";
import { requireModeratorSession } from "@/components/dashboard/session";
import { getDb } from "@/db/client";
import { loadReviewWorkflowHint } from "@/lib/github/actions";
import { loadModerationProductDetail, loadModerationQueue } from "@/lib/moderation/queue";

// The queue is a runtime fact: every request reads the database, never a build-time cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "审核台",
  // The console hides behind a 404 for non-moderators; it must not be indexed either.
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
}

export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The layout already gated the segment; this is the same memoised read, kept here because
  // the page needs the reviewer's name.
  const session = await requireModeratorSession();
  const db = getDb();
  const raw = await searchParams;
  const productParam = firstValue(raw.product);
  const versionParam = firstValue(raw.version);

  const queue = await loadModerationQueue(db);

  // A version link may only carry `?version=`; the queue is what maps it back to a product.
  const versionRow = versionParam
    ? (queue.versions.find((row) => row.versionId === versionParam) ?? null)
    : null;
  const requestedProductId = productParam ?? versionRow?.productId ?? null;

  // With nothing selected, open the first item so the console is never a blank pane.
  const fallbackProductId =
    queue.products[0]?.productId ?? queue.versions[0]?.productId ?? null;
  const subjectId = requestedProductId ?? fallbackProductId;

  const detail = subjectId ? await loadModerationProductDetail(db, subjectId) : null;
  // `?version=` only counts when it belongs to the product actually shown, so a stale link
  // cannot highlight one row while the detail pane describes another product.
  const focusedVersionId =
    versionParam && detail?.versions.some((version) => version.id === versionParam)
      ? versionParam
      : null;
  // The detail pane falls back to the first held version when the URL names none; repeating
  // that one predicate keeps the hint and the highlighted row describing the same version.
  const hintVersionId =
    focusedVersionId ??
    detail?.versions.find((version) => version.state === "pending_review")?.id ??
    null;

  // Started, not awaited: `DetailPanel` streams the GitHub Actions hint behind Suspense, so a
  // slow API never delays the console's first paint. The helper caps itself at 3s, returns
  // null on every failure, and the catch below is the last line of defence (plan §7.4 item 25).
  const workflowHint = detail
    ? loadReviewWorkflowHint(db, {
        productId: detail.product.id,
        repoId: detail.product.repoId,
        versionId: hintVersionId,
      }).catch(() => null)
    : null;

  // One timestamp for the whole render, so every "waiting" value agrees with its neighbours.
  const now = Date.now();

  const reviewer = session.account.displayName ?? session.account.username;

  // The console owns the rest of the viewport on desktop: the shell top bar + its 1px rule.
  // Panes scroll inside that box, so the document itself never scrolls at 1633×810.
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 pb-8 pt-4 md:h-[calc(var(--viewport-h)-var(--app-topbar-h)-1px)] md:px-5 md:pb-4">
      <PageHeader
        title="审核台"
        description="首个产品与等审版本都在这里人工裁决。版本声明了没审过的能力、产品改名或换了仓库，会重新回到队列；通过后能力集合并入已审快照。"
        actions={
          <>
            <Stat
              variant="bare"
              label="待审产品"
              value={queue.products.length}
            />
            <Stat
              variant="bare"
              label="等审版本"
              value={queue.versions.length}
            />
            <div className="hidden max-w-[16ch] sm:block">
              <div className="truncate text-[12.5px] font-medium">
                {reviewer ?? "—"}
              </div>
              <div className="mt-1 text-[12.5px] text-muted-foreground">审核身份</div>
            </div>
          </>
        }
      />

      <ModerationShell
        queue={
          <QueuePanel
            queue={queue}
            selectedProductId={detail?.product.id ?? null}
            selectedVersionId={focusedVersionId}
            now={now}
          />
        }
        detail={
          detail ? (
            <DetailPanel
              detail={detail}
              focusedVersionId={focusedVersionId}
              now={now}
              workflowHint={workflowHint}
            />
          ) : requestedProductId ? (
            <DetailMissing />
          ) : (
            <DetailEmpty />
          )
        }
      />
    </div>
  );
}

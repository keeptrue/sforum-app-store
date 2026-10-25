import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DashboardVersion } from "@/lib/products/types";

import { VersionActions } from "./actions/version-actions";
import { diffCapabilities, formatAgo, versionStateLabel, versionStateTone } from "./format";

/**
 * Version history as the reviewer sees it. Held versions carry their own approve/reject
 * buttons because that is a separate decision from the product lifecycle; the "能力"
 * column flags rows whose declared keys are not in the approved snapshot yet.
 * The focused row sits on the accent surface, matching the queue's selection language.
 */
export function VersionTable({
  versions,
  approved,
  productName,
  firstReview,
  focusedVersionId,
  now,
}: {
  versions: DashboardVersion[];
  approved: string[];
  productName: string;
  firstReview: boolean;
  focusedVersionId: string | null;
  now: number;
}) {
  if (versions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted-foreground">
        该产品还没有版本，因此没有可审的内容。
      </p>
    );
  }

  return (
    <div className="[&_td]:px-1.5 [&_th]:px-1.5 sm:[&_td]:px-2 sm:[&_th]:px-2">
      <Table>
        <caption className="sr-only">版本与审核状态</caption>
        <TableHeader>
          <TableRow>
            <TableHead>版本</TableHead>
            <TableHead className="hidden sm:table-cell">频道</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="hidden md:table-cell">sforumVersion</TableHead>
            <TableHead className="hidden lg:table-cell">清单</TableHead>
            <TableHead>能力</TableHead>
            <TableHead className="hidden md:table-cell">发布</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((version) => {
            const diff = diffCapabilities(approved, version.capabilities);
            const focused = version.id === focusedVersionId;
            const held = version.state === "pending_review";
            return (
              <TableRow
                key={version.id}
                className={cn(
                  focused && "bg-accent/60 hover:bg-accent/60",
                )}
              >
                <TableCell className="whitespace-nowrap font-mono text-xs font-medium">
                  {version.version}
                </TableCell>
                <TableCell className="hidden font-mono text-[12.5px] text-muted-foreground sm:table-cell">
                  {version.channel}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={versionStateTone(version.state)}
                    title={version.yankReason ?? undefined}
                  >
                    {versionStateLabel(version.state)}
                  </Badge>
                </TableCell>
                <TableCell className="hidden font-mono text-[12.5px] md:table-cell">
                  {version.sforumVersion}
                </TableCell>
                <TableCell className="hidden max-w-[220px] lg:table-cell">
                  {version.manifestAuthorName ? (
                    <div className="min-w-0 text-[12.5px]">
                      {version.manifestAuthorUrl ? (
                        <a
                          href={version.manifestAuthorUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline decoration-border underline-offset-2 hover:text-foreground"
                        >
                          {version.manifestAuthorName}
                        </a>
                      ) : (
                        <span>{version.manifestAuthorName}</span>
                      )}
                      {version.manifestDescription ? (
                        <p
                          className="truncate text-[12px] text-muted-foreground"
                          title={version.manifestDescription}
                        >
                          {version.manifestDescription}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-[12.5px]">
                  <span className="tabular-nums">{version.capabilities.length}</span>
                  {diff.added.length > 0 && !firstReview ? (
                    <Badge variant="warning" className="ml-1.5 align-middle">
                      +{diff.added.length}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell
                  className="hidden whitespace-nowrap text-[12.5px] tabular-nums text-muted-foreground md:table-cell"
                  title={version.publishedAt ?? undefined}
                >
                  {version.publishedAt ? formatAgo(version.publishedAt, now) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {held ? (
                    <VersionActions
                      versionId={version.id}
                      version={version.version}
                      productName={productName}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

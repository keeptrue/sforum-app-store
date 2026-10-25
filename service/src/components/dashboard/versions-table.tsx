"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { YankDialog } from "@/components/dashboard/yank-dialog";
import {
  CHANNEL_LABELS,
  VERSION_STATE_LABELS,
  VERSION_STATE_TONES,
  formatDay,
  platformLabel,
} from "@/components/dashboard/labels";
import type { DashboardVersion } from "@/lib/products/types";

/**
 * Version history as synced from GitHub. The dashboard never edits a version: it can only
 * yank a published one. Low-signal columns collapse below `xl` so the table stays readable at
 * 390px instead of scrolling sideways.
 */
export function VersionsTable({ versions }: { versions: DashboardVersion[] }) {
  const [target, setTarget] = useState<DashboardVersion | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>版本</CardTitle>
        <CardDescription>
          版本由 GitHub release 同步产生，以清单里的 version 为准。撤回只影响已发布的版本。
        </CardDescription>
      </CardHeader>

      <CardContent className="px-2 pb-1">
        {versions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-[13px] leading-relaxed text-muted-foreground">
            还没有版本。把仓库绑定到 GitHub App 并推送一个 release，同步完成后版本会出现在这里。
          </p>
        ) : (
          <Table aria-label="产品版本列表">
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead className="hidden lg:table-cell">渠道</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">sforumVersion</TableHead>
                <TableHead className="hidden sm:table-cell">发布时间</TableHead>
                <TableHead className="hidden xl:table-cell">平台</TableHead>
                <TableHead className="hidden xl:table-cell">能力</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell className="font-mono text-[13px] whitespace-nowrap">
                    {version.version}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="font-mono text-[12.5px] text-muted-foreground">
                      {CHANNEL_LABELS[version.channel]}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={VERSION_STATE_TONES[version.state]}>
                        {VERSION_STATE_LABELS[version.state]}
                      </Badge>
                      {version.state === "yanked" && version.yankReason ? (
                        <span
                          className="hidden max-w-[160px] truncate text-[12px] text-muted-foreground sm:block"
                          title={version.yankReason}
                        >
                          理由：{version.yankReason}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
                      {version.sforumVersion}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-[12.5px] whitespace-nowrap text-muted-foreground sm:table-cell">
                    {formatDay(version.publishedAt)}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {version.assetPlatforms.length === 0 ? (
                        <span className="text-[12.5px] text-muted-foreground">—</span>
                      ) : (
                        version.assetPlatforms.map((platform) => (
                          <span
                            key={platformLabel(platform)}
                            className="rounded border border-border px-1 py-0.5 font-mono text-[12px] text-muted-foreground"
                          >
                            {platformLabel(platform)}
                          </span>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {version.capabilities.length === 0 ? (
                        <span className="text-[12.5px] text-muted-foreground">无</span>
                      ) : (
                        <>
                          {version.capabilities.slice(0, 3).map((capability) => (
                            <span
                              key={capability}
                              className="rounded border border-border px-1 py-0.5 font-mono text-[12px] text-muted-foreground"
                            >
                              {capability}
                            </span>
                          ))}
                          {version.capabilities.length > 3 ? (
                            <span className="text-[12px] text-muted-foreground">
                              +{version.capabilities.length - 3}
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {version.state === "published" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setTarget(version)}
                      >
                        <Undo2 aria-hidden />
                        撤回
                      </Button>
                    ) : (
                      <span className="text-[12.5px] text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <YankDialog
        version={target}
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    </Card>
  );
}

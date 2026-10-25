"use client";

import { Ban, Check } from "lucide-react";

import { Button } from "@/components/ui/button";

import { ModerationDialog } from "./moderation-dialog";

/**
 * Decision for one held version. Approving adds the version's capability set to the
 * approved snapshot the moment it publishes, which is why the diff is shown first.
 */
export function VersionActions({
  versionId,
  version,
  productName,
}: {
  versionId: string;
  version: string;
  productName: string;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <ModerationDialog
        trigger={
          <Button variant="ghost" size="sm">
            <Ban className="size-3.5" aria-hidden />
            拒绝
          </Button>
        }
        title={`拒绝 ${productName} ${version}？`}
        description="该版本变为「已拒绝」，不会出现在公开目录；产品的其它版本不受影响。理由会写进审核事件。"
        confirmLabel="提交拒绝"
        target={{ kind: "version", id: versionId }}
        action="reject"
        success={`已拒绝 ${productName} ${version}`}
        destructive
        reason={{
          label: "拒绝理由",
          placeholder: "说明这个版本需要改什么。",
        }}
      />
      <ModerationDialog
        trigger={
          <Button variant="outline" size="sm">
            <Check className="size-3.5" aria-hidden />
            批准
          </Button>
        }
        title={`批准 ${productName} ${version}？`}
        description="批准后该版本立即可被下载，它的能力集合并入已审快照，并写入审核事件与审计记录。"
        confirmLabel="批准该版本"
        target={{ kind: "version", id: versionId }}
        action="approve"
        success={`已批准 ${productName} ${version}`}
      />
    </div>
  );
}

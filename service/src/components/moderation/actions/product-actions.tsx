"use client";

import { Ban, Check, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DashboardProduct } from "@/lib/products/types";

import { ModerationDialog } from "./moderation-dialog";

/**
 * Product-level decisions. Approve publishes the product and every version it currently
 * holds; reject sends it back with a reason; delist pulls a published product offline.
 * Nothing here claims anything about a build — approval is a human decision on the data
 * the reviewer can see.
 */
export function ProductActions({ product }: { product: DashboardProduct }) {
  if (product.status === "pending_review") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <ModerationDialog
          trigger={
            <Button variant="outline" size="sm">
              <Ban className="size-3.5" aria-hidden />
              拒绝
            </Button>
          }
          title={`拒绝 ${product.name}？`}
          description="产品状态变为「已拒绝」，版本保持原样；开发者修改文案后可以重新提交。理由会写进审核事件。"
          confirmLabel="提交拒绝"
          target={{ kind: "product", id: product.id }}
          action="reject"
          success={`已拒绝 ${product.name}`}
          destructive
          reason={{
            label: "拒绝理由",
            placeholder: "说明需要改什么，开发者会看到这段话。",
          }}
        />
        <ModerationDialog
          trigger={
            <Button size="sm">
              <Check className="size-3.5" aria-hidden />
              批准
            </Button>
          }
          title={`批准 ${product.name}？`}
          description="批准后产品立即上线，它当前所有候选与待审版本一起发布，并写入审核事件与审计记录。"
          confirmLabel="批准并上线"
          target={{ kind: "product", id: product.id }}
          action="approve"
          success={`已批准 ${product.name}`}
        />
      </div>
    );
  }

  if (product.status === "published") {
    return (
      <ModerationDialog
        trigger={
          <Button variant="outline" size="sm">
            <ShieldOff className="size-3.5" aria-hidden />
            下架
          </Button>
        }
        title={`下架 ${product.name}？`}
        description="下架后目录不再展示该产品，已签发的下载链接立即失效。重新上线需要重新提交并通过审核。"
        confirmLabel="提交下架"
        target={{ kind: "product", id: product.id }}
        action="delist"
        success={`已下架 ${product.name}`}
        destructive
        reason={{
          label: "下架理由",
          placeholder: "写下架原因；这会出现在审核事件里。",
        }}
      />
    );
  }

  return null;
}

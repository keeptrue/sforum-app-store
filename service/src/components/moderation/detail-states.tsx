import Link from "next/link";
import { Inbox, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Right pane when nothing is selected or the selection disappeared under us. */
export function DetailEmpty() {
  return (
    <div className="grid min-h-full place-items-center px-6 py-16 text-center">
      <div className="max-w-[40ch]">
        <div className="mx-auto grid size-9 place-items-center rounded-md bg-secondary">
          <Inbox className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <h2 className="mt-3 text-sm font-semibold tracking-tight">还没有选中待审项</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          从左侧队列选一项，这里会显示提交人、版本与能力差异、事件时间线，以及批准与拒绝。
        </p>
      </div>
    </div>
  );
}

export function DetailMissing() {
  return (
    <div className="grid min-h-full place-items-center px-6 py-16 text-center">
      <div className="max-w-[40ch]">
        <div className="mx-auto grid size-9 place-items-center rounded-md bg-secondary">
          <RefreshCw className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <h2 className="mt-3 text-sm font-semibold tracking-tight">
          这个待审项已经不在了
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          它可能刚被其他管理员处理过，或者产品已被删除。刷新队列即可看到最新状态。
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link href="/moderation">刷新队列</Link>
        </Button>
      </div>
    </div>
  );
}

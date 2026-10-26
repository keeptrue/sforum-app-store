import { TriangleAlert } from "lucide-react";

import { getSyncQueueHealth, syncAlertText } from "@/lib/ops/sync-health";

/**
 * A queue that is not draining is invisible in the catalog: the store still serves the last
 * published version and every page looks healthy. This banner is the one place a developer
 * sees "your release is waiting because nothing is consuming webhooks".
 *
 * It is deliberately best-effort: a missing pgboss schema (fresh database, worker never
 * started) must not take the developer portal down with it.
 */
export async function SyncAlert() {
  let text: string | null;
  try {
    text = syncAlertText(await getSyncQueueHealth());
  } catch {
    return null;
  }
  if (text === null) return null;

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pt-4">
      <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <div className="min-w-0 text-[13px] leading-relaxed">
          <p className="font-medium text-foreground">版本同步可能已停</p>
          <p className="text-muted-foreground">{text}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            管理员可在后台「系统健康」查看队列与 webhook。
          </p>
        </div>
      </div>
    </div>
  );
}

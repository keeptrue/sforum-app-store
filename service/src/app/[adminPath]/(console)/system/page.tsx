import { PageHeader } from "@/components/common/page-header";
import { SystemConfigPanel } from "@/components/admin/system-config-panel";
import { SystemDatabasePanel } from "@/components/admin/system-database-panel";
import { SystemSummaryBar } from "@/components/admin/system-panel";
import { SystemQueuePanel } from "@/components/admin/system-queue-panel";
import { SystemRateLimitPanel } from "@/components/admin/system-ratelimit-panel";
import { SystemTablesPanel } from "@/components/admin/system-tables-panel";
import { SystemWebhookPanel } from "@/components/admin/system-webhook-panel";
import { failedSections, loadSystemHealth, summarizeHealth } from "@/lib/admin/system";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "系统健康" };

/**
 * Read-only operations page. Each panel owns its own failure, so a broken subsystem still
 * leaves the rest of the page legible — that is the whole point of this surface.
 */
export default async function AdminSystemPage() {
  const health = await loadSystemHealth();
  const summary = summarizeHealth(health);
  const failures = failedSections(health);

  return (
    <>
      <PageHeader
        title="系统健康"
        description="只读：数据库、队列、限流、webhook、表计数与配置自检。这里没有任何写操作。"
      />

      <SystemSummaryBar
        summary={summary}
        generatedAt={health.generatedAt}
        failures={failures}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <SystemDatabasePanel data={health.database} />
        <SystemQueuePanel data={health.queues} />
        <SystemRateLimitPanel data={health.rateLimits} />
        <SystemWebhookPanel data={health.webhooks} />
        <SystemTablesPanel data={health.tables} />
        <SystemConfigPanel data={health.config} />
      </div>
    </>
  );
}

import { SystemPanel, Metric, PanelError } from "@/components/admin/system-panel";
import { Badge } from "@/components/ui/badge";
import type { DatabaseHealth, Section } from "@/lib/admin/system";

export function SystemDatabasePanel({ data }: { data: Section<DatabaseHealth> }) {
  return (
    <SystemPanel id="database" title="数据库" hint="select 1 探活 + 连接池">
      {data.ok ? (
        <DatabaseBody data={data.value} />
      ) : (
        <PanelError label="数据库" message={data.error} />
      )}
    </SystemPanel>
  );
}

function DatabaseBody({ data }: { data: DatabaseHealth }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={data.reachable ? "success" : "destructive"}>
          {data.reachable ? "可达" : "不可达"}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {data.reachable ? `${data.latencyMs ?? 0} ms` : "—"}
        </span>
      </div>

      {data.error ? (
        <p className="font-mono text-[12.5px] break-all text-destructive">{data.error}</p>
      ) : null}

      <dl className="grid grid-cols-2 gap-4">
        <Metric label="host" value={data.connection.host} mono />
        <Metric label="database" value={data.connection.database} mono />
      </dl>

      {data.pool ? (
        <dl className="grid grid-cols-3 gap-3 border-t border-border pt-3">
          <Metric label="连接池总数" value={data.pool.total} />
          <Metric label="空闲" value={data.pool.idle} />
          <Metric
            label="等待中"
            value={data.pool.waiting}
            hint={data.pool.waiting > 0 ? "有请求在排队等连接" : undefined}
          />
        </dl>
      ) : (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          连接池计数不可读（探活未建立连接池）。
        </p>
      )}

      <p className="text-[12.5px] text-muted-foreground">
        只显示 host 与库名；连接串本身（含口令）不进入响应。
      </p>
    </div>
  );
}

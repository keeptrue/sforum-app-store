import { PanelError, SystemPanel } from "@/components/admin/system-panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { QueuesHealth, Section } from "@/lib/admin/system";

/**
 * pg-boss backlog per queue. `created/retry/active` is what still has to run; `failed` is
 * terminal (pg-boss keeps failed jobs until retention sweeps them), so it is shown apart
 * instead of being folded into the backlog number.
 */
export function SystemQueuePanel({ data }: { data: Section<QueuesHealth> }) {
  return (
    <SystemPanel id="queues" title="队列" hint="pgboss.job 按 state 分组">
      {data.ok ? <QueueTable data={data.value} /> : <PanelError label="队列" message={data.error} />}
    </SystemPanel>
  );
}

function QueueTable({ data }: { data: QueuesHealth }) {
  if (data.queues.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        没有注册任何队列。worker 启动时会创建 <span className="font-mono">github-webhook</span> 与{" "}
        <span className="font-mono">release-sync</span>。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>队列</TableHead>
            <TableHead className="text-right">created</TableHead>
            <TableHead className="text-right">retry</TableHead>
            <TableHead className="text-right">active</TableHead>
            <TableHead className="text-right">failed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.queues.map((queue) => {
            const backlog = queue.created + queue.retry + queue.active;
            return (
              <TableRow key={queue.name}>
                <TableCell className="font-mono text-xs">
                  {queue.name}
                  {backlog === 0 && queue.failed === 0 ? (
                    <span className="ml-2 text-[12.5px] text-muted-foreground">空</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {queue.created}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {queue.retry}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {queue.active}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {queue.failed}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-[12.5px] text-muted-foreground">
        created / retry / active 是待处理量；failed 是已终止的失败 job（保留到 retention 清理）。
      </p>
    </div>
  );
}

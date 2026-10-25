import { PanelError, SystemPanel } from "@/components/admin/system-panel";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Section, WebhooksHealth } from "@/lib/admin/system";

const STATUS_BADGE: Record<string, "success" | "warning" | "muted" | "outline"> = {
  processed: "success",
  failed: "warning",
  received: "muted",
};

function statusLabel(status: string): string {
  if (status === "processed") return "已处理";
  if (status === "failed") return "失败";
  if (status === "received") return "已接收";
  return status;
}

export function SystemWebhookPanel({ data }: { data: Section<WebhooksHealth> }) {
  return (
    <SystemPanel id="webhooks" title="Webhook 投递" hint="最近 10 条 + 按状态计数">
      {data.ok ? (
        <WebhookBody data={data.value} />
      ) : (
        <PanelError label="Webhook" message={data.error} />
      )}
    </SystemPanel>
  );
}

function WebhookBody({ data }: { data: WebhooksHealth }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">共 {data.total}</Badge>
        {Object.entries(data.byStatus).map(([status, count]) => (
          <Badge key={status} variant={STATUS_BADGE[status] ?? "outline"}>
            {statusLabel(status)} {count}
          </Badge>
        ))}
      </div>

      {data.recent.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          还没有收到任何 webhook 投递。
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>delivery</TableHead>
              <TableHead>事件</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">接收时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.recent.map((delivery) => (
              <TableRow key={delivery.deliveryId}>
                <TableCell className="max-w-[14rem] truncate font-mono text-[12.5px]">
                  {delivery.deliveryId}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  <span className="font-mono">{delivery.event}</span>
                  {delivery.action ? (
                    <span className="text-muted-foreground"> / {delivery.action}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[delivery.status] ?? "outline"}>
                    {statusLabel(delivery.status)}
                  </Badge>
                  {delivery.error ? (
                    <span className="mt-1 block max-w-[16rem] truncate font-mono text-[12px] text-destructive">
                      {delivery.error}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
                  {delivery.receivedAt.replace("T", " ").slice(0, 19)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <p className="text-[12.5px] text-muted-foreground">
        「已接收」表示已入库但 worker 还没处理完；长时间停在「已接收」通常意味着 worker 没在跑。
      </p>
    </div>
  );
}

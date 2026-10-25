import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestampUtc, type AuditEntry } from "@/lib/admin/audit";

/**
 * The trail itself. `details` opens in place with a native `<details>` — the payloads are
 * small JSON blobs read once per investigation, and a dependency for that would be a bad trade.
 */

const ACTOR_KIND_LABEL: Record<AuditEntry["actor"]["kind"], string> = {
  admin: "管理员",
  forum: "论坛账号",
  system: "系统",
};

function DetailsCell({ details }: { details: Record<string, unknown> | null }) {
  if (details === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  const keys = Object.keys(details).length;

  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
        展开 {keys} 个字段
      </summary>
      <pre className="mt-1.5 max-h-64 max-w-[36rem] overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[13px] leading-relaxed">
        {JSON.stringify(details, null, 2)}
      </pre>
    </details>
  );
}

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[9.5rem]">时间（UTC）</TableHead>
            <TableHead className="w-[11rem]">操作人</TableHead>
            <TableHead className="w-[14rem]">动作</TableHead>
            <TableHead>目标</TableHead>
            <TableHead className="w-[8.5rem]">IP</TableHead>
            <TableHead className="w-[9rem]">详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
                {formatTimestampUtc(entry.createdAt)}
              </TableCell>
              <TableCell>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm">{entry.actor.label}</span>
                  <Badge variant={entry.actor.kind === "system" ? "muted" : "outline"}>
                    {ACTOR_KIND_LABEL[entry.actor.kind]}
                  </Badge>
                </span>
              </TableCell>
              <TableCell className="font-mono text-[12.5px] break-all">{entry.action}</TableCell>
              <TableCell>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[12.5px]">{entry.targetType}</span>
                  {entry.targetId ? (
                    <span
                      className="truncate font-mono text-[12.5px] text-muted-foreground"
                      title={entry.targetId}
                    >
                      {entry.targetId}
                    </span>
                  ) : (
                    <span className="text-[12.5px] text-muted-foreground">无目标 id</span>
                  )}
                </span>
              </TableCell>
              <TableCell className="font-mono text-[12.5px] text-muted-foreground">
                {entry.ip ?? "—"}
              </TableCell>
              <TableCell>
                <DetailsCell details={entry.details} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

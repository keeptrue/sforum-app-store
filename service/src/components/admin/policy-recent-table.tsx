import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestampUtc } from "@/lib/admin/audit";
import { describeReason, type RecentDecision } from "@/lib/admin/policy";

/**
 * The last decisions the system actually recorded. Rows are read from `moderation_events`, so
 * this table is evidence, not a re-simulation of the policy.
 */

const OUTCOME_COPY: Record<
  RecentDecision["outcome"],
  { label: string; variant: "success" | "warning" }
> = {
  published: { label: "已发布", variant: "success" },
  pending_review: { label: "退回人工", variant: "warning" },
};

export function PolicyRecentTable({ decisions }: { decisions: RecentDecision[] }) {
  if (decisions.length === 0) {
    return (
      <div className="surface px-6 py-10 text-center">
        <p className="text-sm font-medium">还没有发布判定记录</p>
        <p className="mx-auto mt-1 max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
          同步任务第一次按策略裁决新版本、或第一次有人审核通过产品时，这里才会出现记录。
        </p>
      </div>
    );
  }

  return (
    <div className="surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[9.5rem]">时间（UTC）</TableHead>
            <TableHead>产品</TableHead>
            <TableHead className="w-[8rem]">版本</TableHead>
            <TableHead className="w-[7rem]">结论</TableHead>
            <TableHead className="w-[14rem]">触发原因</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {decisions.map((decision) => (
            <TableRow key={decision.id}>
              <TableCell className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
                {formatTimestampUtc(decision.createdAt)}
              </TableCell>
              <TableCell className="max-w-[22rem] truncate">
                {decision.productName ?? "（产品已删除）"}
              </TableCell>
              <TableCell className="font-mono text-[12.5px]">
                {decision.version ?? "—"}
              </TableCell>
              <TableCell>
                <Badge variant={OUTCOME_COPY[decision.outcome].variant}>
                  {OUTCOME_COPY[decision.outcome].label}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {describeReason(decision.reason) ?? (
                  <span className="font-mono text-[12.5px]">{decision.action}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

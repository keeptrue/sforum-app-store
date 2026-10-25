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
import type { RateLimitsHealth, Section } from "@/lib/admin/system";

/**
 * Rate-limit pressure, current window only.
 *
 * Honesty note that must stay in the UI: `rate_limits` stores a fixed-window counter per
 * (bucket, window start) and nothing else — there is no event stream, so a trend chart would
 * be fabricated. Each row is resolved against its channel's own window length, which is why
 * a bucket's "current window" can start at a different minute than its neighbour's.
 */
export function SystemRateLimitPanel({ data }: { data: Section<RateLimitsHealth> }) {
  return (
    <SystemPanel id="rate-limits" title="限流窗口" hint="当前窗口计数最高的 10 个 bucket">
      {data.ok ? (
        <RateLimitBody data={data.value} />
      ) : (
        <PanelError label="限流" message={data.error} />
      )}
    </SystemPanel>
  );
}

function RateLimitBody({ data }: { data: RateLimitsHealth }) {
  return (
    <div className="space-y-3">
      {data.buckets.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          当前窗口内没有任何 bucket 计数。限流只在登录、提交、下载等入口被触发时写入。
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>bucket</TableHead>
              <TableHead className="text-right">计数 / 上限</TableHead>
              <TableHead className="text-right">窗口起点</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.buckets.map((bucket) => {
              const saturated = bucket.count >= bucket.limit;
              return (
                <TableRow key={bucket.bucket}>
                  <TableCell className="max-w-[22rem] truncate font-mono text-xs">
                    {bucket.bucket}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <span className="font-mono text-xs tabular-nums">
                      {bucket.count} / {bucket.limit}
                    </span>
                    {saturated ? (
                      <Badge variant="warning" className="ml-2">
                        已满
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">
                    {bucket.windowStart.replace("T", " ").slice(0, 19)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="space-y-1 text-[12.5px] text-muted-foreground">
        <p>
          这是<strong className="font-medium">固定窗口计数</strong>
          ：每个 bucket 只有「当前窗口」一行，没有历史事件流，所以这里看不到趋势，也不画时间序列图。
        </p>
        <p className="font-mono">
          窗口起点按各通道自己的窗口长度对齐；过期窗口 {data.staleBuckets} 个，未识别通道{" "}
          {data.unknownChannelBuckets} 个（不计入上表）。
        </p>
      </div>
    </div>
  );
}

import Link from "next/link";
import { AlertCircle } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";

/**
 * Inline failure for an unusable catalog URL. The page never throws on a bad query:
 * a broken `?cursor=` or `?limit=` is a user-editable input, not a server fault.
 */
export function CatalogError({
  code,
}: {
  code: "invalid_query" | "invalid_cursor";
}) {
  const copy =
    code === "invalid_cursor"
      ? {
          title: "分页游标已失效",
          body: "链接里的 cursor 不是本商城签发的分页游标。回到目录首页重新翻页即可。",
        }
      : {
          title: "筛选参数无法识别",
          body: "链接里的筛选条件超出了目录支持的取值（类型、分类、平台、频道或每页数量）。去掉这些参数后重试。",
        };

  return (
    <div className="min-w-0">
      <section className="pb-5 pt-8">
        <h1 className="text-[clamp(32px,3.1vw,42px)] font-semibold leading-[1.15] tracking-[-.01em]">
          挑一件，装进你的<span className="text-foreground/70">论坛</span>。
        </h1>
        <p className="page-lede mt-2 max-w-[38em]">
          这个地址带了一个目录读不懂的参数，先回到干净的目录再挑。
        </p>
      </section>

      <EmptyState
        icon={AlertCircle}
        title={
          <span className="flex flex-wrap items-center justify-center gap-2">
            {copy.title}
            <span className="rounded-[6px] border border-warning/30 bg-warning/10 px-1.5 py-[3px] font-mono text-[12px] font-normal text-warning">
              {code}
            </span>
          </span>
        }
        description={copy.body}
        action={
          <Link
            href="/"
            className="press inline-flex h-[34px] items-center rounded-pill border border-input bg-card px-4 text-xs font-medium hover:bg-secondary"
          >
            回到目录
          </Link>
        }
      />
    </div>
  );
}

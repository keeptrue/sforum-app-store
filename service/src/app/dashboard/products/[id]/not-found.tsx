import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Scoped 404 for the product editor. The page turns *every* read failure into `notFound()`,
 * so this copy has to cover both cases without telling them apart: a wrong id and someone
 * else's product are indistinguishable on purpose (plan §5.9, 越权按 404).
 */
export default function ProductNotFound() {
  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pb-16 pt-16">
      <div className="surface mx-auto max-w-xl p-6">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-evidence text-evidence-foreground">
            <ShieldAlert className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-display font-semibold tracking-tight">
              找不到这个产品
            </h1>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              它不存在，或者属于另一个账号。别人的产品与不存在的产品返回同一个
              404，商城不泄漏资源的存在性。
            </p>
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="mt-4">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden />
            返回我的产品
          </Link>
        </Button>
      </div>
    </div>
  );
}

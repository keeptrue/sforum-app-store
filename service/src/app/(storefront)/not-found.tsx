import Link from "next/link";
import { PackageSearch } from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";

/**
 * Storefront 404. One answer for every miss: an unpublished product, a delisted one,
 * a disconnected repository and an unknown slug are indistinguishable on purpose.
 */
export default function StorefrontNotFound() {
  return (
    <div className="min-w-0">
      <EmptyState
        icon={PackageSearch}
        className="mt-6 py-[90px]"
        title="这个扩展不存在"
        description="它可能没有通过审核、已被撤回，或者仓库已经断开。目录不会说明是哪一种。"
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

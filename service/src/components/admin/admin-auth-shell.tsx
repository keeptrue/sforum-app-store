import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

/**
 * Frame for the three unauthenticated console pages (login / setup / password): a single
 * centred card on the page background, no navigation — there is nothing to navigate to yet.
 * The theme switch is still present: the login page is part of the product.
 */
export function AdminAuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[var(--viewport-h)] flex-col">
      <div className="flex justify-end px-4 py-4">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-20">
        <div className="w-full max-w-sm">
          {/* The forms here submit through `fetch`; without JavaScript the buttons stay
              disabled (see `useHydrated`) instead of falling back to a native GET that would
              put credentials in the URL. Say why rather than looking broken. */}
          <noscript>
            <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              这个页面需要 JavaScript 才能提交表单。请在浏览器中启用后刷新。
            </p>
          </noscript>
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <BrandMark size={24} />
              <Link
                href="/"
                className="font-display text-sm font-semibold tracking-tight"
              >
                SForum Store
              </Link>
            </div>
            <span className="eyebrow block">管理员后台</span>
          </div>
          <div className="surface p-5">
            <h1 className="font-display text-xl font-semibold tracking-tight">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
            <div className="mt-5">{children}</div>
          </div>
          {footer ? (
            <div className="mt-4 text-xs text-muted-foreground">{footer}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

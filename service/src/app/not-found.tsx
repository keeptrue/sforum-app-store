import Link from "next/link";

/** Root 404 for paths outside the storefront and console groups. */
export default function NotFound() {
  return (
    <main className="grid min-h-[var(--viewport-h)] place-items-center px-5">
      <div className="w-full max-w-sm rounded-card border border-border bg-card px-5 py-8 text-center">
        <span className="font-mono text-[12px] uppercase tracking-[.1em] text-muted-foreground">
          404 · not found
        </span>
        <b className="mt-2 block text-base font-semibold">没有这个页面</b>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          地址可能过期或拼错了。目录仍然在首页。
        </p>
        <Link
          href="/"
          className="press mt-4 inline-flex h-[34px] items-center rounded-pill border border-input bg-card px-4 text-xs font-medium hover:bg-secondary"
        >
          回到目录
        </Link>
      </div>
    </main>
  );
}

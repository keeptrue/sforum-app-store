import Link from "next/link";

/** Rail footer for the public catalog: the one exit into the developer portal. */
export function StorePortalCard() {
  return (
    <div className="rounded-cup border border-border bg-card p-3.5">
      <b className="text-[12.5px] font-semibold">开发者门户</b>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        身份只来自 SForum 的 OAuth2，商城没有注册和密码。
      </p>
      <Link
        href="/dashboard"
        className="press mt-2.5 grid h-8 w-full place-items-center rounded-control border border-border bg-accent text-xs font-semibold text-accent-foreground hover:bg-secondary"
      >
        进入后台
      </Link>
    </div>
  );
}

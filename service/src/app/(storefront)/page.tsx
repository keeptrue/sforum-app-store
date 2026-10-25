import { Catalog } from "@/components/storefront/catalog";
import { CatalogError } from "@/components/storefront/catalog-error";
import {
  IssuerNotice,
  issuerNoticeCode,
} from "@/components/storefront/issuer-notice";
import { getDb } from "@/db/client";
import { listCatalog, parseCatalogQuery } from "@/lib/catalog/query";

// The build must not need a database connection, and a local Postgres is not a
// build-time dependency: every request reads the catalog.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;

  const serverQuery = new URLSearchParams();
  const current = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      serverQuery.set(key, value);
      current.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) serverQuery.append(key, item);
      if (value.length > 0) current.set(key, value[value.length - 1]!);
    }
  }

  const parsed = parseCatalogQuery(serverQuery);
  if (!parsed.ok) return <CatalogError code={parsed.code} />;

  // `?error=` belongs to the login hand-off, not to the catalog: showing it in the banner is
  // useful, carrying it into pagination links is not.
  const notice = issuerNoticeCode(raw.error);
  current.delete("error");

  const { body } = await listCatalog(getDb(), parsed.query);

  return (
    <div className="min-w-0">
      <section className="flex flex-wrap items-end gap-x-6 gap-y-4 pb-5 pt-8">
        <div className="min-w-0">
          <h1 className="text-[clamp(32px,3.1vw,42px)] font-semibold leading-[1.15] tracking-[-.01em]">
            挑一件，装进你的<span className="text-foreground/70">论坛</span>。
          </h1>
          <p className="mt-2 max-w-[38em] text-[14px] leading-[1.7] text-muted-foreground">
            每个包都带签名与摘要，论坛取回后只落到「暂存」。信任、启用、回滚，都在你自己的后台完成。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-pill border border-success/25 bg-success/10 px-3.5 py-2 text-[12.5px] text-success ml-auto">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-success ring-[3px] ring-success/15"
          />
          安装止于暂存 · 启用由论坛管理员确认
        </div>
      </section>

      {notice ? <IssuerNotice code={notice} /> : null}

      <Catalog body={body} params={Object.fromEntries(current)} />

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[12.5px] text-muted-foreground">
        <span>商城不存包体 · 下载链接 30 分钟内有效 · 安装止于暂存</span>
        <span className="font-mono">SSR · PostgreSQL</span>
      </footer>
    </div>
  );
}

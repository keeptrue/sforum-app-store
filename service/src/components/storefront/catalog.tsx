"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import {
  badgeForCompatibility,
  constraintChip,
  describeCompatibility,
  formatMonthDay,
  KIND_TABS,
  PLATFORMS,
} from "@/components/storefront/catalog-format";
import { startNavProgress } from "@/lib/nav-progress";
import type {
  CatalogPageBody,
  Compatibility,
  ProductSummary,
} from "@/lib/catalog/query";
import {
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  isCategoryKey,
} from "@/lib/products/taxonomy";

export type CatalogProps = {
  /** Server read model for the current URL. Never re-fetched on the client. */
  body: CatalogPageBody;
  /** Current URL query, used to build the next URL for every control. */
  params: Record<string, string>;
};

/**
 * Every control writes a real URL: the filter state, the keyset cursor and the
 * server query stay one object. `kind` is part of that query now — a shelf filter
 * that changes `total` — so the pills, the rail and the count can never disagree.
 */
export function Catalog({ body, params }: CatalogProps) {
  const router = useRouter();
  const kind = params.kind ?? "";
  const activePlatform = params.os && params.arch ? `${params.os}/${params.arch}` : null;
  const hasFilters = Boolean(params.q || params.category || params.kind || activePlatform);

  const href = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    // Any filter change invalidates the keyset cursor.
    next.delete("cursor");
    const search = next.toString();
    return search ? `/?${search}` : "/";
  };

  const setPlatform = (value: string) => {
    const [os, arch] = value.split("/");
    // A platform filter is a server render of the whole grid: no link, so the bar has to
    // be told.
    startNavProgress();
    router.push(
      href((next) => {
        if (!os || !arch) {
          next.delete("os");
          next.delete("arch");
        } else {
          next.set("os", os);
          next.set("arch", arch);
        }
      }),
    );
  };

  // The contract marks `CatalogPage.compatibility` optional; when the read model omits it
  // the page simply does not claim a compatibility state.
  const compatibility: Compatibility = body.compatibility ?? {
    status: "unknown",
    estimated: false,
  };
  const compatNote = describeCompatibility(compatibility, params.compat);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {KIND_TABS.map(([value, label]) => {
          const active = value === "all" ? kind === "" : kind === value;
          const target = value === "all" ? "" : value;
          return (
            <Link
              key={value}
              href={href((next) => {
                if (target) next.set("kind", target);
                else next.delete("kind");
              })}
              aria-current={active ? "page" : undefined}
              className={pill(active)}
            >
              {label}
            </Link>
          );
        })}

        <span aria-hidden className="mx-1 h-[18px] w-px bg-border" />

        {CATEGORY_KEYS.map((key) => {
          const active = params.category === key;
          return (
            <Link
              key={key}
              href={href((next) => {
                if (active) next.delete("category");
                else next.set("category", key);
              })}
              aria-current={active ? "page" : undefined}
              className={pill(active)}
            >
              {CATEGORY_LABELS[key]}
            </Link>
          );
        })}

        <span aria-hidden className="mx-1 h-[18px] w-px bg-border" />

        <label className="relative inline-flex items-center">
          <span className="sr-only">平台</span>
          <select
            value={activePlatform ?? ""}
            onChange={(event) => setPlatform(event.target.value)}
            className="press h-8 appearance-none rounded-pill border border-border bg-card pl-3.5 pr-8 font-mono text-[12.5px] text-muted-foreground outline-none hover:border-input hover:text-foreground"
          >
            <option value="">全部平台</option>
            {PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 size-3.5 text-muted-foreground"
            aria-hidden
          />
        </label>

        <span className="ml-auto text-[12.5px] text-muted-foreground">
          本页 <b className="font-semibold text-foreground">{body.items.length}</b> / 共{" "}
          {body.total} 个产品
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-[18px] text-[12.5px] text-muted-foreground">
        <span>{compatNote}</span>
        {hasFilters && <span>· 已按当前条件筛选</span>}
      </div>

      {body.items.length === 0 ? (
        <EmptyState hasFilters={hasFilters} kind={kind} />
      ) : (
        // Shelf widths are measured on the grid's own column, never the viewport: the rail
        // leaves a 1024 viewport with ~596px of content, so 560 is the floor that keeps it at
        // two columns instead of collapsing to one. 1340 is where a four-column card still
        // holds 321px — (1340 − 3×18) / 4.
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @min-[560px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[960px]:gap-[18px] @min-[1340px]:grid-cols-4">
            {body.items.map((product) => (
              <ProductCard key={product.slug} product={product} />
            ))}
          </div>
        </div>
      )}

      <Pagination params={params} total={body.total} nextCursor={body.nextCursor ?? null} />
    </>
  );
}

function pill(active: boolean) {
  return `press inline-flex h-8 items-center gap-1.5 rounded-pill border px-3.5 text-[12.5px] ${
    active
      ? "border-transparent bg-primary font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.3)]"
      : "border-border bg-card text-muted-foreground hover:border-input hover:text-foreground"
  }`;
}

const pageBtn =
  "inline-flex h-7 items-center gap-1 rounded-pill border border-border bg-card px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:border-input hover:text-foreground";

const COMPAT_TONE: Record<"success" | "destructive" | "warning", string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
};

/** The muted chip both the platform row and the constraint use. */
const META_CHIP =
  "rounded-[6px] border border-border bg-evidence px-1.5 py-[3px] font-mono text-[12px] text-muted-foreground";

/**
 * One card, one link. The plate carries the category wash and the product glyph; the
 * kind badge sits on the plate.
 *
 * The meta row carries *product facts* — category, platforms, the manifest's
 * `sforumVersion` — and, only when the page actually has one, a host verdict. A page
 * without a host version says so once above the grid instead of stamping 「未校验」 on
 * every card, which was constant noise sitting in the product's own judgement slot.
 */
function ProductCard({ product }: { product: ProductSummary }) {
  const compatibility = badgeForCompatibility(product.compatibility);
  const constraint = constraintChip(product.sforumVersion);
  const plate = isCategoryKey(product.category) ? `plate-${product.category}` : "";
  const category = isCategoryKey(product.category)
    ? CATEGORY_LABELS[product.category]
    : null;
  const extraPlatforms = Math.max(0, product.platforms.length - 2);

  return (
    <Link
      href={`/p/${product.slug}`}
      aria-label={`查看 ${product.name} 详情`}
      className="group @container/card flex h-full flex-col overflow-hidden rounded-card border border-border bg-card text-left transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-[3px] hover:border-foreground/20 hover:shadow-[0_26px_50px_-26px_rgba(18,18,18,.35)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {/* 42cqw tracks the card, not the viewport: the plate keeps its 152px at three columns
          (370 → 155, clamped) and sheds height in a 272px card so the meta row keeps its room. */}
      <div
        className={`plate-surface ${plate} relative mx-2 mt-2 flex h-[clamp(124px,42cqw,152px)] items-end overflow-hidden rounded-plate px-4 pb-4`}
      >
        {product.socialImageUrl ? (
          // The package's own 1280×640 brand card is the cover. It is a real picture, not a
          // generated wash, so the decorative rings step aside; if the asset 404s (pruned
          // storage, restored backup) the plate underneath is still a finished surface.
          <img
            src={product.socialImageUrl}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            className="pointer-events-none absolute inset-0 size-full object-cover"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <span aria-hidden className="plate-rings absolute inset-0" />
        )}
        {product.iconUrl ? (
          <img
            src={product.iconUrl}
            alt=""
            width={44}
            height={44}
            className="relative size-11 rounded-[12px] object-cover shadow-[0_2px_10px_rgba(18,18,18,.14)]"
          />
        ) : (
          <span
            className="relative text-[46px] font-semibold leading-none tracking-[-.02em]"
            style={{ color: "var(--plate-ink)" }}
            aria-hidden
          >
            {product.name.trim().slice(0, 1) || "?"}
          </span>
        )}
        <span className="absolute right-3 top-3 rounded-[7px] border border-border bg-card/70 px-1.5 py-1 font-mono text-[12px] font-semibold uppercase tracking-[.1em] text-foreground/70 backdrop-blur-sm">
          {product.kind === "plugin" ? "PLUGIN" : "THEME"}
        </span>
      </div>

      <div className="flex flex-1 flex-col px-4 pb-4 pt-3.5">
        <h3 className="truncate text-[clamp(16.5px,4.6cqw,19px)] font-semibold leading-tight tracking-[-.01em]">
          {product.name}
        </h3>
        <div className="mt-1 truncate font-mono text-[12px] text-muted-foreground">
          {product.extensionId}
        </div>

        <p className="mt-2.5 line-clamp-2 min-h-[2lh] text-[14px] leading-[1.7] text-muted-foreground">
          {product.summary || "该产品还没有填写摘要。"}
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {category && (
            <span className="rounded-[6px] border border-border bg-secondary px-1.5 py-[3px] font-mono text-[12px] text-muted-foreground">
              {category}
            </span>
          )}
          {product.platforms.length === 0 ? (
            <span className={META_CHIP}>暂无平台资产</span>
          ) : (
            product.platforms.slice(0, 2).map((item) => (
              <span key={`${item.os}/${item.arch}`} className={META_CHIP}>
                {item.os}/{item.arch}
              </span>
            ))
          )}
          {extraPlatforms > 0 && (
            <span className="font-mono text-[12px] text-muted-foreground">
              +{extraPlatforms}
            </span>
          )}
          {constraint && (
            <span className={META_CHIP} title={constraint.title}>
              sforum {constraint.text}
            </span>
          )}
          {compatibility && (
            <span
              title={compatibility.hint}
              className={`inline-flex items-center gap-1.5 text-[12px] ${COMPAT_TONE[compatibility.variant]} @min-[380px]/card:ml-auto`}
            >
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {compatibility.label}
            </span>
          )}
        </div>

        <div className="mt-auto flex items-center gap-2.5 pt-4">
          <span className="font-display text-[12.5px] font-medium tabular-nums">
            v{product.latestVersion}
          </span>
          <span className="text-[12.5px] tabular-nums text-muted-foreground">
            {formatMonthDay(product.updatedAt)}
          </span>
          <span className="ml-auto whitespace-nowrap rounded-pill border border-foreground/20 bg-foreground/[.07] px-3 py-1.5 text-[12.5px] font-semibold text-foreground transition-colors group-hover:border-transparent group-hover:bg-primary group-hover:text-primary-foreground">
            <span className="hidden @min-[340px]/card:inline">查看</span>安装包
          </span>
        </div>
      </div>
    </Link>
  );
}

function EmptyState({ hasFilters, kind }: { hasFilters: boolean; kind: string }) {
  const narrowed = hasFilters || kind !== "";
  const title = narrowed ? "没有符合条件的扩展" : "还没有已发布的扩展";
  const body = narrowed
    ? "换一个关键词、分类或平台再试。"
    : "商城还没有收录任何已发布的扩展，稍后再来看看。";

  return (
    <div className="grid grid-cols-1 place-items-center rounded-card border border-dashed border-input px-5 py-[70px] text-center">
      <div className="max-w-sm">
        <b className="block text-base font-semibold">{title}</b>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
        {narrowed && (
          <Link
            href="/"
            className="press mt-4 inline-flex h-[34px] items-center rounded-pill border border-input bg-card px-4 text-xs font-medium hover:bg-secondary"
          >
            清空筛选
          </Link>
        )}
      </div>
    </div>
  );
}

function Pagination({
  params,
  total,
  nextCursor,
}: {
  params: Record<string, string>;
  total: number;
  nextCursor: string | null;
}) {
  const cursor = params.cursor ?? null;
  const firstPageHref = (() => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    const search = next.toString();
    return search ? `/?${search}` : "/";
  })();
  const nextPageHref = (() => {
    if (!nextCursor) return null;
    const next = new URLSearchParams(params);
    next.set("cursor", nextCursor);
    return `/?${next.toString()}`;
  })();

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[12.5px] text-muted-foreground">
      <span>
        共 {total} 个产品
        {cursor ? " · 非首页" : ""}
      </span>
      <div className="flex items-center gap-1.5">
        {cursor ? (
          <Link href={firstPageHref} className={pageBtn}>
            <ChevronLeft className="size-3.5" aria-hidden />
            上一组
          </Link>
        ) : (
          <span className={`${pageBtn} pointer-events-none opacity-40`}>
            <ChevronLeft className="size-3.5" aria-hidden />
            上一组
          </span>
        )}
        {nextPageHref ? (
          <Link href={nextPageHref} className={pageBtn}>
            下一页
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        ) : (
          <span className={`${pageBtn} pointer-events-none opacity-40`}>
            下一页
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        )}
      </div>
    </div>
  );
}

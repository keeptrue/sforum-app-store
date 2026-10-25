"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  ShieldCheck,
} from "lucide-react";

import { EmptyState } from "@/components/common/empty-state";
import { ReadmeContent } from "@/components/readme/readme-content";
import { ReadmeTocInline, ReadmeTocRail } from "@/components/readme/readme-toc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copyDigest } from "@/components/storefront/clipboard";
import { UNJUDGED_LABEL } from "@/components/storefront/catalog-format";
import { useInstallDialog } from "@/components/storefront/install-store";
import {
  blockedReason,
  digestPreview,
  formatBytes,
  formatDay,
  splitPlatform,
  statusLabel,
  statusVariant,
} from "@/components/storefront/product-format";
import {
  CAPABILITY_CATALOG_PROVENANCE,
  CAPABILITY_RISK_BADGE,
  CAPABILITY_RISK_LABELS,
  capabilityBreakdown,
  type CapabilitySummary,
} from "@/lib/capabilities/catalog";
import type { ProductDetail, ReleaseVersion } from "@/lib/catalog/query";
import { extractHeadings } from "@/lib/readme/headings";
import { categoryLabel, isCategoryKey } from "@/lib/products/taxonomy";

const SELECT_CLASS =
  "mt-1 h-9 w-full rounded-[10px] border border-input bg-card px-2.5 text-xs text-foreground outline-none transition-colors focus-visible:border-foreground/50";

function displayUrl(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "—";
  }
}

const STATUS_TONE: Record<string, string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
};

/** Sidebar headline for one release's capability set; `null` when nothing is declared. */
function capabilityHeadline(summary: CapabilitySummary): string | null {
  if (!summary.maxRisk) return null;
  if (summary.maxRisk === "high") return `含 ${summary.byRisk.high} 项高风险能力`;
  if (summary.maxRisk === "medium") return `含 ${summary.byRisk.medium} 项中风险能力`;
  return "均为低风险能力";
}

/**
 * Everything rendered here comes from `ProductDetail` (PostgreSQL read model) plus the
 * vendored host capability catalog. The page invents no prose, digest, permission or
 * compatibility claim of its own: capability labels and tiers are the host's, copied
 * verbatim, and `risk` describes what host surface a capability reaches — never whether an
 * extension is safe.
 *
 * Download semantics: `GET /api/v1/products/{slug}/download/{os}/{arch}` signs the
 * product's latest stable release (`version: null`). `releases[]` is semver-descending,
 * so the first published stable entry is exactly what that route will serve — the version
 * picker may select older ones for reading their digest, and the CTA turns off when the
 * selection is not the servable one.
 */
export function ProductView({ product }: { product: ProductDetail }) {
  const openInstall = useInstallDialog((state) => state.open);
  const [tab, setTab] = useState("overview");

  const releases = product.releases;
  const platforms = product.platforms;

  const routeRelease =
    releases.find(
      (release) => release.status === "published" && release.channel === "stable",
    ) ?? null;

  const [version, setVersion] = useState(
    routeRelease?.version ?? releases[0]?.version ?? "",
  );
  // Prefer a platform the servable release actually ships, so the page does not open
  // on a selection whose download is legitimately blocked.
  const initialPlatform = routeRelease?.assets[0] ?? platforms[0] ?? null;
  const [platformKey, setPlatformKey] = useState(
    initialPlatform ? `${initialPlatform.os}/${initialPlatform.arch}` : "",
  );

  const selected = releases.find((release) => release.version === version) ?? null;
  const { os, arch } = splitPlatform(platformKey);
  const asset =
    selected?.assets.find((item) => item.os === os && item.arch === arch) ?? null;
  const servable =
    Boolean(asset) &&
    selected?.version === routeRelease?.version &&
    selected?.status === "published";

  const downloadHref =
    os && arch ? `/api/v1/products/${product.slug}/download/${os}/${arch}` : null;
  // Nothing to hand out when the servable release carries no asset at all.
  const canInstall = Boolean(routeRelease && routeRelease.assets.length > 0);

  // Capabilities are per release; the newest visible release is what the tab describes.
  // `undefined` and `[]` both mean "the manifest declared nothing extra".
  const capabilitiesRelease = releases[0] ?? null;
  const capabilities: string[] | null = capabilitiesRelease
    ? (capabilitiesRelease.capabilities ?? [])
    : null;
  // Labels and tiers are the host's; unknown keys keep `risk: null` instead of a guess.
  const capabilityView = capabilityBreakdown(capabilities ?? []);
  // The sidebar advertises the release that would be installed, which may be older than the
  // one the capability tab describes.
  const selectedCapabilities = capabilityBreakdown(selected?.capabilities ?? []);
  const selectedCapabilityHeadline = capabilityHeadline(selectedCapabilities.summary);
  // Manifest display metadata follows the same release as the capability tab: the newest
  // visible one, so the two blocks never describe different versions.
  const manifestRelease = releases[0] ?? null;
  const manifest = manifestRelease?.manifest ?? null;
  const manifestLocales = manifest?.langs ? Object.keys(manifest.langs).sort() : [];
  const localized = manifest?.langs?.["zh-CN"] ?? null;
  const category = categoryLabel(product.category);
  const plate = isCategoryKey(product.category) ? `plate-${product.category}` : "";
  // One product per page, so a constant id is enough for the table of contents to find the
  // rendered document. `getElementById` is the only consumer; nothing links to it.
  const readmeId = "product-readme";
  // Derived on the server too: the contents ship in the markup instead of appearing after
  // hydration, so the list exists without JavaScript and nothing shifts when it mounts.
  const readmeHeadings = product.readme ? extractHeadings(product.readme.html) : [];

  const facts = [
    ["最新版本", `v${selected?.version ?? product.latestVersion}`, false],
    ["更新时间", formatDay(product.updatedAt), false],
    ["平台", platforms.map((item) => `${item.os}/${item.arch}`).join(" · ") || "—", true],
    ["sforumVersion", selected?.sforumVersion ?? "—", true],
    ["包大小", formatBytes(asset?.size), false],
    ["维护者", product.owner ?? "未绑定账号", false],
    ["清单作者", manifest?.author?.name ?? "—", false],
    ["项目主页", displayUrl(manifest?.url), false],
    ["清单语言", manifestLocales.length > 0 ? manifestLocales.join(" · ") : "—", true],
  ] as const;

  return (
    <div className="min-w-0 pt-4">
      <nav
        aria-label="面包屑"
        className="flex flex-wrap items-center gap-1.5 py-1 text-[12.5px] text-muted-foreground"
      >
        <Link href="/" className="hover:text-foreground">
          目录
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        <Link
          href={product.kind === "plugin" ? "/?kind=plugin" : "/?kind=theme"}
          className="hover:text-foreground"
        >
          {product.kind === "plugin" ? "插件" : "主题"}
        </Link>
        <ChevronRight className="size-3" aria-hidden />
        <span className="truncate text-foreground">{product.name}</span>
      </nav>

      {/* `overflow-clip` rather than `overflow-hidden`: hidden would make this card the
          nearest scrollport, which is what stops the README table of contents from sticking. */}
      <article className="mt-3 overflow-clip rounded-panel border border-border bg-card">
        <header className="flex flex-wrap items-center gap-3.5 border-b border-border px-5 py-[18px] lg:px-6">
          <div
            className={`plate-surface ${plate} grid size-[52px] shrink-0 place-items-center overflow-hidden rounded-[16px] text-[26px] font-semibold`}
            style={{ color: "var(--plate-ink)" }}
          >
            {product.iconUrl ? (
              <img
                src={product.iconUrl}
                alt=""
                width={52}
                height={52}
                className="size-full object-cover"
              />
            ) : (
              <span aria-hidden>{product.name.trim().slice(0, 1) || "?"}</span>
            )}
          </div>

          <div className="min-w-0">
            <h1 className="text-[25px] font-semibold leading-tight tracking-[-.01em]">
              {product.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-muted-foreground">
              <span>{product.extensionId}</span>
              {category && (
                <>
                  <span aria-hidden>·</span>
                  <span>{category}</span>
                </>
              )}
              <span aria-hidden>·</span>
              <span>{product.owner ?? "未绑定账号"}</span>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {product.repoUrl && (
              <a
                href={product.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <GitBranch className="size-3.5" aria-hidden />
                仓库
              </a>
            )}
            <button
              type="button"
              disabled={!canInstall}
              onClick={() => {
                if (!routeRelease) return;
                openInstall({
                  slug: product.slug,
                  name: product.name,
                  version: routeRelease.version,
                  platforms: routeRelease.assets.map((item) => ({
                    os: item.os,
                    arch: item.arch,
                    sha256: item.sha256,
                    size: item.size,
                    filename: item.filename,
                  })),
                });
              }}
              className="press inline-flex h-9 items-center gap-1.5 rounded-[11px] bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.25)] disabled:pointer-events-none disabled:opacity-40"
            >
              <Download className="size-3.5" aria-hidden />
              获取安装包
            </button>
          </div>
        </header>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_316px]">
          <div className="min-w-0 px-5 pb-7 pt-4 lg:px-6">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList
                aria-label="产品信息"
                className="flex h-auto w-full items-center gap-1 rounded-xl border border-border bg-secondary p-1 md:w-fit"
              >
                {[
                  ["overview", "说明"],
                  ["versions", `版本 ${releases.length}`],
                  ["compat", "兼容性"],
                  ["capabilities", `声明的能力 ${capabilities?.length ?? 0}`],
                ].map(([value, label]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="h-[30px] flex-1 rounded-[9px] px-3 text-xs text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_rgba(18,18,18,.08)] md:flex-none"
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent
                value="overview"
                forceMount
                className="mt-4 data-[state=inactive]:hidden"
              >
                {manifest ? (
                  <section className="mb-5 rounded-cup border border-border bg-card px-4 py-3.5">
                    <h2 className="text-[13px] font-semibold">清单简介</h2>
                    <p className="mt-1.5 max-w-[72ch] text-[13px] leading-relaxed text-foreground/90">
                      {manifest.description ?? "该版本的清单没有简介。"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted-foreground">
                      {manifest.author?.name ? (
                        <span>
                          作者{" "}
                          {manifest.author.url ? (
                            <a
                              href={manifest.author.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
                            >
                              {manifest.author.name}
                            </a>
                          ) : (
                            manifest.author.name
                          )}
                        </span>
                      ) : null}
                      {manifest.url ? (
                        <a
                          href={manifest.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                        >
                          <ExternalLink className="size-3" aria-hidden />
                          项目主页
                        </a>
                      ) : null}
                      {manifestLocales.length > 0 ? (
                        <span>清单语言 {manifestLocales.join(" · ")}</span>
                      ) : null}
                    </div>
                    {localized && (localized.name || localized.description) ? (
                      <p className="mt-2 max-w-[72ch] text-[12.5px] leading-relaxed text-muted-foreground">
                        {localized.name ? (
                          <b className="font-medium text-foreground">{localized.name}</b>
                        ) : null}
                        {localized.name && localized.description ? " · " : null}
                        {localized.description ?? null}
                      </p>
                    ) : null}
                  </section>
                ) : null}

                {product.readme ? (
                  // The prose column is capped at a reading measure; the card is wide enough
                  // that the leftover space takes the table of contents instead of staying
                  // empty. Below `lg` there is no second column to give away, so the list
                  // collapses into a `<details>` above the text.
                  <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_180px] lg:gap-8">
                    <div className="min-w-0">
                      <div className="lg:hidden">
                        <ReadmeTocInline
                          key={product.slug}
                          headings={readmeHeadings}
                          containerId={readmeId}
                        />
                      </div>
                      <ReadmeContent
                        id={readmeId}
                        html={product.readme.html}
                        className="readme max-w-[72ch]"
                      />
                    </div>
                    <ReadmeTocRail
                      key={product.slug}
                      headings={readmeHeadings}
                      containerId={readmeId}
                      className="hidden lg:block"
                    />
                  </div>
                ) : (
                  <EmptyState
                    compact
                    icon={FileText}
                    title="该产品还没有可展示的 README"
                    description="商城只展示仓库里的 README；作者没有提供，或商城还没有读到。"
                    action={
                      product.repoUrl ? (
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={product.repoUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            <ExternalLink aria-hidden />
                            在 GitHub 查看
                          </a>
                        </Button>
                      ) : undefined
                    }
                  />
                )}

                <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-muted-foreground">
                  介绍来自仓库 README，由 GitHub 实时提供，商城不对其背书。
                  {product.readme ? (
                    <a
                      href={product.readme.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                    >
                      <ExternalLink className="size-3" aria-hidden />
                      在 GitHub 查看
                      <span className="sr-only">（在新窗口打开）</span>
                    </a>
                  ) : null}
                </p>

                <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-cup border border-border bg-border sm:grid-cols-3">
                  {facts.map(([label, value, mono]) => (
                    <div key={label} className="min-w-0 bg-card px-3.5 py-3">
                      <dt className="text-[12px] uppercase tracking-[.06em] text-muted-foreground">
                        {label}
                      </dt>
                      <dd
                        className={`mt-1 truncate text-[12px] text-foreground ${
                          mono ? "font-mono text-[12px] text-muted-foreground" : ""
                        }`}
                        title={value}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>

                <section className="mt-7">
                  <h2 className="text-[13px] font-semibold">它来自哪里</h2>
                  <ul className="mt-2.5 max-w-[72ch] space-y-1.5 rounded-cup border border-border bg-evidence px-3.5 py-3 text-xs leading-relaxed text-evidence-foreground">
                    {[
                      "版本号以扩展清单为准，GitHub 的 release tag 只是标签。",
                      "摘要由商城对发布资产流式计算；单个版本可能挂多个平台的包。",
                      product.repoUrl
                        ? "仓库地址来自产品绑定；商城不暴露 GitHub 的上游下载地址。"
                        : "该产品尚未绑定仓库，因此没有仓库链接可展示。",
                    ].map((item) => (
                      <li key={item} className="flex gap-2">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              </TabsContent>

              <TabsContent
                value="versions"
                forceMount
                className="mt-4 data-[state=inactive]:hidden"
              >
                {releases.length === 0 ? (
                  <p className="rounded-cup border border-dashed border-input px-3 py-8 text-center text-xs text-muted-foreground">
                    该产品还没有已发布的版本。
                  </p>
                ) : (
                  <>
                    <div className="overflow-hidden rounded-cup border border-border">
                      {releases.map((release, index) => (
                        <VersionRow
                          key={release.version}
                          release={release}
                          latest={index === 0}
                        />
                      ))}
                    </div>
                    <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                      摘要来自该版本已接受的资产；一个版本可以挂多个平台的包，此时逐资产查看。
                      浏览器入口只签发最新稳定版，旧版本摘要用于核对已取到的包。
                    </p>
                  </>
                )}
              </TabsContent>

              <TabsContent
                value="compat"
                forceMount
                className="mt-4 data-[state=inactive]:hidden"
              >
                <p className="max-w-[72ch] text-xs leading-relaxed text-muted-foreground">
                  清单里的{" "}
                  <code className="rounded bg-muted px-1 font-mono text-[12.5px]">
                    sforumVersion
                  </code>{" "}
                  是 Masterminds 约束，不是版本号。本页没有携带宿主版本，所以只展示约束、不判定兼容；
                  core 安装时的 incompatible 仍是最终权威。
                </p>
                <div className="mt-3 overflow-hidden rounded-cup border border-border">
                  {releases.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                      暂无版本
                    </p>
                  ) : (
                    releases.map((release) => (
                      <div
                        key={release.version}
                        className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-xs last:border-b-0"
                      >
                        <span className="font-display text-[12.5px] font-semibold tabular-nums">
                          v{release.version}
                        </span>
                        <span className="truncate font-mono text-[12.5px] text-muted-foreground">
                          {release.sforumVersion}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <span aria-hidden className="size-1.5 rounded-full bg-current" />
                          {UNJUDGED_LABEL}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              <TabsContent
                value="capabilities"
                forceMount
                className="mt-4 data-[state=inactive]:hidden"
              >
                <h2 className="text-[13px] font-semibold">声明的能力</h2>
                <p className="mt-1 max-w-[72ch] text-[13px] leading-relaxed text-muted-foreground">
                  {capabilitiesRelease ? (
                    <>
                      来自{" "}
                      <span className="font-mono text-foreground/80">
                        {capabilitiesRelease.version}
                      </span>{" "}
                      的扩展清单；标签与等级取自 SForum 宿主能力目录（
                      <span
                        title={`${CAPABILITY_CATALOG_PROVENANCE.commit} · 同步于 ${CAPABILITY_CATALOG_PROVENANCE.syncedAt}`}
                      >
                        {CAPABILITY_CATALOG_PROVENANCE.commitShort}
                      </span>
                      ），商城不另行判定。
                    </>
                  ) : (
                    "该产品还没有版本，因此没有能力声明。"
                  )}
                </p>
                {capabilitiesRelease && (
                  <p className="mt-1.5 max-w-[72ch] text-[12px] leading-relaxed text-muted-foreground">
                    等级描述该能力在宿主侧能碰到什么面，不代表插件质量或是否经过审计。宿主还会按
                    backend / settings / jobs / mail.provider 推断追加能力，最终授权以论坛启用页为准。
                  </p>
                )}
                {capabilities === null ? null : capabilities.length === 0 ? (
                  <p className="mt-3 rounded-cup border border-dashed border-input px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                    该版本未声明额外能力；宿主仍可能按清单其他字段推断追加。
                  </p>
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-border bg-evidence px-3 py-2 text-[12.5px]">
                      <span className="font-medium text-foreground">
                        {capabilityView.summary.total} 项能力
                      </span>
                      <span className="text-muted-foreground">
                        高 {capabilityView.summary.byRisk.high} · 中{" "}
                        {capabilityView.summary.byRisk.medium} · 低{" "}
                        {capabilityView.summary.byRisk.low}
                        {capabilityView.summary.unknown > 0
                          ? ` · 未收录 ${capabilityView.summary.unknown}`
                          : ""}
                      </span>
                      {capabilityView.summary.maxRisk && (
                        <span className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          最高等级
                          <Badge variant={CAPABILITY_RISK_BADGE[capabilityView.summary.maxRisk]}>
                            {CAPABILITY_RISK_LABELS[capabilityView.summary.maxRisk]}
                          </Badge>
                        </span>
                      )}
                    </div>
                    <div className="mt-2 overflow-hidden rounded-cup border border-border">
                      {capabilityView.entries.map((entry) => (
                        <div
                          key={entry.key}
                          className="border-b border-border px-3.5 py-2.5 last:border-b-0"
                        >
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <b className="break-all font-mono text-[12.5px] font-medium">
                              {entry.key}
                            </b>
                            {entry.labelZh ? (
                              <span className="text-[12.5px] text-foreground/85">
                                {entry.labelZh}
                              </span>
                            ) : (
                              <span className="text-[12px] text-muted-foreground">
                                不在商城快照（可能由更高版本宿主新增）
                              </span>
                            )}
                            <Badge
                              variant={entry.risk ? CAPABILITY_RISK_BADGE[entry.risk] : "muted"}
                              className="ml-auto"
                            >
                              {entry.risk ? CAPABILITY_RISK_LABELS[entry.risk] : "未收录"}
                            </Badge>
                          </div>
                          {entry.description && (
                            <details className="mt-1">
                              <summary className="w-fit cursor-pointer text-[12px] text-muted-foreground">
                                宿主说明（英文原文）
                              </summary>
                              <p className="mt-1 max-w-[72ch] text-[12px] leading-relaxed text-muted-foreground">
                                {entry.description}
                              </p>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                      安装时由论坛展示，管理员可以逐项拒绝。
                    </p>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </div>

          <aside className="border-t border-border bg-evidence p-4 lg:border-l lg:border-t-0">
            <div className="rounded-cup border border-border bg-card p-4 lg:sticky lg:top-[88px]">
              <h2 className="text-[12px] font-semibold uppercase tracking-[.1em] text-muted-foreground">
                安装包 · v{selected?.version ?? product.latestVersion}
              </h2>
              {selectedCapabilityHeadline && selectedCapabilities.summary.maxRisk && (
                <Badge
                  variant={CAPABILITY_RISK_BADGE[selectedCapabilities.summary.maxRisk]}
                  className="mt-2"
                >
                  {selectedCapabilityHeadline}
                </Badge>
              )}

              <label className="mt-3 block text-[12.5px] text-muted-foreground">
                版本
                <select
                  className={SELECT_CLASS}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                >
                  {releases.map((release) => (
                    <option key={release.version} value={release.version}>
                      {release.version} · {release.channel}
                      {release.status === "yanked" ? " · 已撤回" : ""}
                    </option>
                  ))}
                  {releases.length === 0 && <option value="">暂无版本</option>}
                </select>
              </label>

              <fieldset className="mt-3">
                <legend className="text-[12.5px] text-muted-foreground">平台</legend>
                <div className="mt-1 grid gap-1">
                  {platforms.length === 0 && (
                    <span className="rounded-[9px] border border-dashed border-input px-2 py-1.5 font-mono text-[12px] text-muted-foreground">
                      暂无平台资产
                    </span>
                  )}
                  {platforms.map((item) => {
                    const key = `${item.os}/${item.arch}`;
                    const checked = platformKey === key;
                    return (
                      <label
                        key={key}
                        className={`flex cursor-pointer items-center gap-2 rounded-[9px] border px-2 py-1.5 font-mono text-[12px] transition-colors ${
                          checked
                            ? "border-foreground/25 bg-accent text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-accent/60"
                        }`}
                      >
                        <input
                          type="radio"
                          name="platform"
                          value={key}
                          checked={checked}
                          onChange={() => setPlatformKey(key)}
                          className="size-3 accent-[var(--primary)]"
                        />
                        {key}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-3 flex items-center justify-between gap-2 rounded-[9px] border border-border bg-evidence px-2.5 py-2">
                <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-muted-foreground">
                  sha256 {asset ? `${asset.sha256.slice(0, 8)}…${asset.sha256.slice(-4)}` : "—"}
                </code>
                {asset && (
                  <button
                    type="button"
                    onClick={() => copyDigest(asset.sha256)}
                    aria-label="复制 SHA-256 摘要"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="size-3" aria-hidden />
                  </button>
                )}
              </div>

              <ol className="mt-3 grid gap-2">
                {[
                  ["01", "取签名链接", "302 到签名地址，30 分钟内有效"],
                  ["02", "核对摘要", "下载后先比对 SHA-256"],
                  ["03", "暂存待信任", "启用与信任在论坛后台"],
                ].map(([num, title, note], index) => (
                  <li key={num} className="grid grid-cols-[20px_1fr] gap-2.5 text-[12.5px]">
                    <span
                      className={`grid size-5 place-items-center rounded-full border font-mono text-[12px] leading-none ${
                        servable || index < 2
                          ? "border-foreground/20 bg-accent text-foreground"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      {num}
                    </span>
                    <span>
                      <span className="text-foreground/85">{title}</span>
                      <span className="block text-[12px] leading-relaxed text-muted-foreground">
                        {note}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>

              {servable && downloadHref ? (
                <a
                  href={downloadHref}
                  download
                  className="press mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-[11px] bg-primary text-xs font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.25)]"
                >
                  <Download className="size-3.5" aria-hidden />
                  下载安装包
                </a>
              ) : (
                <>
                  <button
                    type="button"
                    disabled
                    className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-[11px] bg-primary text-xs font-semibold text-primary-foreground opacity-40"
                  >
                    <Download className="size-3.5" aria-hidden />
                    下载安装包
                  </button>
                  <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                    {blockedReason(selected, asset, routeRelease)}
                  </p>
                </>
              )}

              <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
                链接 30 分钟内有效，可重复取用；安装只到暂存，启用与信任在论坛后台完成。
              </p>
            </div>
          </aside>
        </div>
      </article>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-[12.5px] text-muted-foreground">
        <span>商城不存包体 · 下载时复核版本状态与摘要</span>
        <span className="font-mono">
          {product.extensionId} / {selected?.version ?? product.latestVersion}
        </span>
      </footer>
    </div>
  );
}

function VersionRow({ release, latest }: { release: ReleaseVersion; latest: boolean }) {
  const variant = statusVariant(release);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-xs last:border-b-0">
      <span className="flex items-center gap-1.5">
        <span className="font-display text-[12.5px] font-semibold tabular-nums">
          v{release.version}
        </span>
        {latest && (
          <span className="rounded-[5px] bg-accent px-1 py-0.5 font-mono text-[12px] text-accent-foreground">
            最新
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
        <span className="font-mono">{release.channel}</span>
        <span className="tabular-nums">{formatDay(release.publishedAt)}</span>
        <span
          className="truncate font-mono"
          title={release.digest ?? "多平台版本，按资产分别查看"}
        >
          {digestPreview(release)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 text-[12px] ${STATUS_TONE[variant] ?? "text-muted-foreground"}`}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {statusLabel(release)}
        </span>
        {release.digest && (
          <button
            type="button"
            onClick={() => copyDigest(release.digest!)}
            aria-label={`复制 v${release.version} 的摘要`}
            className="grid size-[26px] place-items-center rounded-[8px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy className="size-3" aria-hidden />
          </button>
        )}
      </span>
    </div>
  );
}

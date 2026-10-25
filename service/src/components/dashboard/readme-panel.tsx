"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/empty-state";
import { ReadmeContent } from "@/components/readme/readme-content";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { jsonRequest } from "@/components/dashboard/api";
import { formatDateTime } from "@/components/dashboard/labels";
import { messageFor } from "@/components/dashboard/messages";
import type {
  DashboardProductDetail,
  DashboardReadme,
} from "@/lib/products/types";

/** `blobSha` is a 40-char git object id; the first 12 are what a person can compare by eye. */
const SHA_PREVIEW = 12;

/**
 * README sizes are usually a few KB, so a plain "round to KB" would print `0 KB` for the
 * short ones. Bytes below 1 KiB are shown as-is instead.
 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * The README the store read from the repository.
 *
 * Read-only by construction: the name and the introduction come from GitHub, so there is no
 * editor here. The HTML was rendered and sanitised on the server; the one action re-reads
 * GitHub. A failed refresh keeps the previous good copy on screen and prints `fetchError`
 * inside the panel — the developer has to know the text they are reading is stale, and a
 * toast would be gone before they looked back at it.
 */
export function ReadmePanel({ product }: { product: DashboardProductDetail }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readme = product.readme;
  const unbound = product.repoId === null;

  async function refresh() {
    setPending(true);
    setError(null);
    const result = await jsonRequest<{ readme: { ok: boolean } }>(
      `/api/dashboard/products/${product.id}/readme/refresh`,
      "POST",
    );
    setPending(false);
    if (!result.ok) {
      setError(messageFor(result.failure));
      return;
    }
    // Both outcomes are read back from the row this request wrote. Only a clean fetch earns
    // a toast; a failed one shows up as `fetchError` in the panel that is about to repaint.
    if (result.data.readme.ok) toast.success("已重新拉取 README");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>介绍</CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || unbound}
            onClick={() => void refresh()}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            重新拉取
          </Button>
        </div>
        <CardDescription>
          介绍直接使用仓库的 README：商城只抓取并消毒 HTML，不提供编辑入口，改了 README
          这里才会变。
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {unbound ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            产品还没有绑定仓库。先绑定仓库，商城才能读取它的 README。
          </p>
        ) : null}

        {readme === null ? (
          <EmptyState
            compact
            icon={FileText}
            title="还没有读取到 README"
            description="绑定仓库后商城会读取默认分支的 README。仓库里没有 README，或上一次拉取失败，这里会一直是空的。"
          />
        ) : (
          <>
            <ReadmeMeta readme={readme} />
            {readme.fetchError ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-[12.5px] leading-relaxed text-foreground">
                <TriangleAlert
                  className="mt-0.5 size-3.5 shrink-0 text-warning"
                  aria-hidden
                />
                <span className="min-w-0 break-words">
                  上次拉取失败：{readme.fetchError}
                  ；下面仍是上一次成功读到的内容，可能已经过时。
                </span>
              </p>
            ) : null}
            <ReadmeContent className="readme" html={readme.html} />
          </>
        )}

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[13px] leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Where the text came from, as the four values a person can check against GitHub. */
function ReadmeMeta({ readme }: { readme: DashboardReadme }) {
  const fields = [
    ["路径", readme.path, true],
    ["blob", readme.blobSha.slice(0, SHA_PREVIEW), true],
    ["拉取于", formatDateTime(readme.fetchedAt), false],
    ["大小", formatSize(readme.byteSize), false],
  ] as const;

  return (
    <div className="surface-quiet flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
      <dl className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex min-w-0 items-baseline gap-1.5">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd
              className={`min-w-0 truncate ${mono ? "font-mono" : "tabular-nums"}`}
              title={value}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <a
        href={readme.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground hover:underline"
      >
        <ExternalLink className="size-3" aria-hidden />
        在 GitHub 查看
        <span className="sr-only">（在新窗口打开）</span>
      </a>
    </div>
  );
}

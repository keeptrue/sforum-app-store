import { PageHeader } from "@/components/common/page-header";
import { GithubAppForm, type ManifestOutcome } from "@/components/admin/github-app-form";
import { getDb } from "@/db/client";
import { getConfig } from "@/lib/config";
import { getGithubAppView } from "@/lib/github/app-config";
import { getRuntimeConfig } from "@/lib/settings/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "GitHub App" };

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
}

/**
 * The one place GitHub App credentials are entered (2026-10-25).
 *
 * They used to live in `.env` (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`,
 * `GITHUB_APP_PRIVATE_KEYS`, `GITHUB_API_BASE_URL`); rotating a webhook secret meant editing
 * env and restarting the web process and the worker in lockstep. The row in `github_app_config`
 * is now the single source of truth, and this page is the only writer.
 *
 * Since the manifest flow landed, this page has two doors: one button that lets GitHub create
 * the App for us (id, slug, webhook secret and signing key all arrive by themselves), and the
 * manual form below it for GitHub Enterprise Server and for adopting an App that already
 * exists. Both end in the same row.
 *
 * `getConfig()` is read for two facts the form cannot derive from the row: the public URL the
 * webhook address is built from, and whether production rules apply to `apiBaseUrl`.
 */
export default async function AdminGithubAppPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const config = getConfig();
  const db = getDb();
  const view = await getGithubAppView(db);
  const { publicUrl } = await getRuntimeConfig(db);
  const params = await searchParams;

  const manifestParam = firstValue(params.manifest);
  const outcome: ManifestOutcome | null =
    manifestParam === "created"
      ? {
          status: "created",
          reason: null,
          slug: firstValue(params.slug),
          appId: firstValue(params.appId),
          verified: firstValue(params.verified) === "1",
          replacedAppId: firstValue(params.replaced),
        }
      : manifestParam === "failed"
        ? {
            status: "failed",
            reason: firstValue(params.reason) ?? "internal",
            slug: null,
            appId: null,
            verified: false,
            replacedAppId: null,
          }
        : null;

  return (
    <>
      <PageHeader
        title="GitHub App"
        description="仓库读取、release 同步、安装回调与 webhook 验签都靠这一个 App。凭据只写不读：保存后页面只知道「有没有」，原文再也拿不回来。"
      />
      <GithubAppForm
        view={view}
        publicUrl={publicUrl}
        production={config.nodeEnv === "production"}
        manifestOutcome={outcome}
      />
    </>
  );
}

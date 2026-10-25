/**
 * `readme:rerender` — rebuild every stored README from its stored source.
 *
 * The store keeps both halves of a README row: `markdown` (what GitHub returned) and `html`
 * (what this service rendered from it). That split exists precisely for this script — when
 * the renderer changes (heading anchors, highlighting, table wrappers), the rows that were
 * rendered by the previous version keep the old HTML until they are refreshed. A product's
 * README is only re-fetched when it goes stale, so without this pass a renderer improvement
 * would take up to a cache cycle to appear, and never for a repository that stopped changing.
 *
 *   bun run readme:rerender -- --dry-run
 *   bun run readme:rerender
 *   bun run readme:rerender -- --limit 5
 *
 * Idempotent by construction: the new HTML is compared with the stored HTML and written only
 * when it differs, so a second run reports `changed 0`. Nothing is fetched from GitHub, and
 * `blob_sha` / `fetched_at` are untouched — this is not a refresh, only a re-render.
 */
import { closeDb, getDb } from "@/db/client";
import { githubRepos, productReadmes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { renderReadme } from "@/lib/readme/render";
import { readmeFormatFor } from "@/lib/readme/source";

const USAGE = `用法：
  bun run readme:rerender -- [--dry-run] [--limit N]

  --dry-run  只统计会变化多少行，不写库
  --limit N  最多处理 N 行（灰度用）
`;

type Args = { dryRun: boolean; limit: number | null } | { help: true };

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--limit") {
      const value = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit 需要一个正整数");
      }
      limit = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { dryRun, limit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("help" in args) {
    process.stdout.write(USAGE);
    return;
  }

  const db = getDb();
  const rows = await db
    .select({
      productId: productReadmes.productId,
      path: productReadmes.path,
      markdown: productReadmes.markdown,
      html: productReadmes.html,
      fullName: githubRepos.fullName,
    })
    .from(productReadmes)
    .innerJoin(githubRepos, eq(githubRepos.repoId, productReadmes.repoId))
    .orderBy(productReadmes.productId);

  const targets = args.limit === null ? rows : rows.slice(0, args.limit);

  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of targets) {
    try {
      const html = renderReadme({
        source: row.markdown,
        repoFullName: row.fullName,
        path: row.path,
        format: readmeFormatFor(row.path),
      });
      if (html === row.html) {
        skipped += 1;
        continue;
      }
      changed += 1;
      if (args.dryRun) continue;
      await db
        .update(productReadmes)
        .set({ html })
        .where(eq(productReadmes.productId, row.productId));
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`失败 ${row.fullName}/${row.path}：${reason}\n`);
    }
  }

  process.stdout.write(
    [
      `扫描 ${targets.length} 行（共 ${rows.length}）`,
      `变化 ${changed}`,
      `未变 ${skipped}`,
      `失败 ${failed}`,
      args.dryRun ? "（dry-run，未写库）" : "（已写库）",
    ].join(" · ") + "\n",
  );

  if (failed > 0) process.exitCode = 1;
  await closeDb();
}

await main();

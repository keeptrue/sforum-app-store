import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  auditLog,
  githubRepos,
  productReadmes,
  products,
} from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { GithubError, type GithubReadme } from "./client";
import { refreshProductReadme } from "./readme";

/**
 * The README cache writer.
 *
 * Three promises this suite pins down: the rendered HTML (not the markdown) is what lands in
 * `product_readmes`; a refresh that returns the same blob digest is a no-op for the audit
 * trail; and a failed refresh never destroys the last good copy, because a GitHub outage must
 * not blank the public page.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const REPO = 5_242;
const INSTALL = 88;

let db: Db;
let ownerId: string;
let productId: string;

/** Only `getReadme` is used by the refresh, so the fake implements exactly that. */
function fakeClient(
  result: GithubReadme | Error | (() => Promise<GithubReadme>),
): { getReadme: () => Promise<GithubReadme> } {
  return {
    async getReadme() {
      if (result instanceof Error) throw result;
      if (typeof result === "function") return result();
      return result;
    },
  };
}

function readme(overrides: Partial<GithubReadme> = {}): GithubReadme {
  return {
    path: "README.md",
    sha: "a".repeat(40),
    content: "# Install\n\nRun `bun install`.\n",
    ...overrides,
  };
}

async function readmeRow() {
  const [row] = await db
    .select()
    .from(productReadmes)
    .where(eq(productReadmes.productId, productId));
  return row ?? null;
}

async function changeAudits() {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "product.readme_changed"),
        eq(auditLog.targetId, productId),
      ),
    );
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 5).toString("base64")}`;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);

  const [account] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub: "owner", username: "owner" })
    .returning({ id: accounts.id });
  ownerId = account!.id;

  await db.insert(githubRepos).values({
    repoId: REPO,
    installationId: INSTALL,
    fullName: "acme/markdown-plus",
  });

  const [product] = await db
    .insert(products)
    .values({
      extensionId: "sforum.markdown-plus",
      name: "Markdown Plus",
      kind: "plugin",
      slug: "markdown-plus",
      ownerAccountId: ownerId,
      repoId: REPO,
      status: "published",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  productId = product!.id;
});

afterAll(async () => {
  await closeDb();
});

describe("refreshProductReadme", () => {
  test("fetches, renders and caches the README", async () => {
    const result = await refreshProductReadme(db, {
      productId,
      client: fakeClient(readme()),
    });

    expect(result).toMatchObject({
      ok: true,
      path: "README.md",
      blobSha: "a".repeat(40),
      // Nothing was cached before, so there is no "change" to report.
      changed: false,
      sourceUrl: "https://github.com/acme/markdown-plus/blob/HEAD/README.md",
    });
    if (!result.ok) throw new Error("expected a successful refresh");
    // The author's `#` is clamped to `h2`: the page already owns the h1. The id and the
    // permalink are part of the stored HTML, so the cached row can be deep-linked.
    expect(result.html).toContain('<h2 id="install"');
    expect(result.html).toContain('class="header-anchor"');
    expect(result.html).toContain("<code>bun install</code>");

    const row = await readmeRow();
    expect(row).toMatchObject({
      repoId: REPO,
      ref: "HEAD",
      path: "README.md",
      blobSha: "a".repeat(40),
      byteSize: Buffer.byteLength(readme().content, "utf8"),
      fetchError: null,
    });
    // The HTML is stored, not re-derived on every page view.
    expect(row?.html).toBe(result.html);
    expect(row?.fetchedAt.getTime()).toBe(result.fetchedAt.getTime());

    expect(await changeAudits()).toHaveLength(0);
  });

  test("strips active content before it is stored", async () => {
    const result = await refreshProductReadme(db, {
      productId,
      client: fakeClient(
        readme({ content: "# Hi\n\n<script>steal()</script><img src=x onerror=1>\n" }),
      ),
    });

    if (!result.ok) throw new Error("expected a successful refresh");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("onerror");
    expect((await readmeRow())?.html).not.toContain("onerror");
  });

  test("a second fetch of the same digest writes no change audit", async () => {
    await refreshProductReadme(db, { productId, client: fakeClient(readme()) });
    const first = await readmeRow();

    const second = await refreshProductReadme(db, {
      productId,
      client: fakeClient(readme()),
    });

    expect(second).toMatchObject({ ok: true, changed: false });
    expect(await changeAudits()).toHaveLength(0);

    const rows = await db
      .select()
      .from(productReadmes)
      .where(eq(productReadmes.productId, productId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blobSha).toBe(first?.blobSha);
  });

  test("a changed digest replaces the row and lands in the audit trail", async () => {
    await refreshProductReadme(db, { productId, client: fakeClient(readme()) });

    const changed = await refreshProductReadme(db, {
      productId,
      actorAccountId: ownerId,
      client: fakeClient(
        readme({ sha: "b".repeat(40), content: "# Install\n\nNow with screenshots.\n" }),
      ),
    });

    expect(changed).toMatchObject({ ok: true, blobSha: "b".repeat(40), changed: true });
    expect((await readmeRow())?.blobSha).toBe("b".repeat(40));

    const audits = await changeAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: ownerId,
      targetType: "product",
      details: {
        repoId: REPO,
        path: "README.md",
        from: "a".repeat(40),
        to: "b".repeat(40),
      },
    });
  });

  test("a 404 keeps the previous text and reports no_readme", async () => {
    const first = await refreshProductReadme(db, {
      productId,
      client: fakeClient(readme()),
    });
    if (!first.ok) throw new Error("expected a successful refresh");
    const before = await readmeRow();

    const missing = await refreshProductReadme(db, {
      productId,
      client: fakeClient(new GithubError(404, "Not Found")),
    });

    expect(missing).toEqual({ ok: false, reason: "no_readme" });
    const after = await readmeRow();
    // The page keeps rendering the last good copy; only `fetch_error` changes.
    expect(after?.html).toBe(before?.html);
    expect(after?.blobSha).toBe(before?.blobSha);
    expect(after?.fetchError).toContain("Not Found");
    expect(await changeAudits()).toHaveLength(0);
  });

  test("an oversized README is its own failure reason", async () => {
    await refreshProductReadme(db, { productId, client: fakeClient(readme()) });

    const tooLarge = await refreshProductReadme(db, {
      productId,
      client: fakeClient(new GithubError(413, "readme_too_large")),
    });

    expect(tooLarge).toEqual({ ok: false, reason: "too_large" });
    expect((await readmeRow())?.blobSha).toBe("a".repeat(40));
  });

  test("a product with no repository binding never reaches GitHub", async () => {
    await db
      .update(products)
      .set({ repoId: null })
      .where(eq(products.id, productId));

    let called = false;
    const result = await refreshProductReadme(db, {
      productId,
      client: {
        async getReadme() {
          called = true;
          return readme();
        },
      },
    });

    expect(result).toEqual({ ok: false, reason: "no_repo" });
    expect(called).toBe(false);
  });

  test("without a configured App the refresh reports it instead of fetching", async () => {
    const result = await refreshProductReadme(db, { productId });

    expect(result).toEqual({ ok: false, reason: "github_not_configured" });
    expect(await readmeRow()).toBeNull();
  });
});

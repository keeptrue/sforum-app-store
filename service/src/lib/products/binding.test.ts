import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import {
  accounts,
  auditLog,
  githubInstallations,
  githubRepos,
  products,
  releaseVersions,
  repoClaims,
} from "@/db/schema";
import { GithubError, type GithubRelease } from "@/lib/github/client";
import { recordClaim } from "@/lib/github/claims";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { elfHeader, makeZip, pluginManifest } from "../../../test/zip-fixture";
import {
  bindProductRepo,
  importProductFromRepo,
  loadRepoBinding,
  unbindProductRepo,
  type ImportClient,
} from "./binding";
import { ProductError } from "./service";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;
let productId: string;

const INSTALL = 601;
const REPO = 7_001;
const OTHER_REPO = 7_002;
const STRANGER_INSTALL = 602;
const STRANGER_REPO = 7_003;

async function makeAccount(sub: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub, username: sub })
    .returning({ id: accounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function makeProduct(input: {
  extensionId: string;
  ownerAccountId: string;
  repoId?: number | null;
  status?: "draft" | "published";
  slug: string;
}): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      extensionId: input.extensionId,
      name: input.extensionId,
      kind: "plugin",
      slug: input.slug,
      ownerAccountId: input.ownerAccountId,
      repoId: input.repoId ?? null,
      status: input.status ?? "draft",
    })
    .returning({ id: products.id });
  if (!row) throw new Error("product insert returned no row");
  return row.id;
}

async function auditActions(productId_: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "product"), eq(auditLog.targetId, productId_)));
  return rows.map((row) => row.action).sort();
}

function releaseWith(zip: Buffer, name = "plugin.zip"): GithubRelease {
  return {
    id: 90,
    tag_name: "v1.4.2",
    target_commitish: "main",
    prerelease: false,
    draft: false,
    body: "notes",
    assets: [
      {
        id: 91,
        name,
        size: zip.length,
        content_type: "application/zip",
        browser_download_url: `https://example.test/${name}`,
      },
    ],
  };
}

function fakeClient(
  options: { release?: GithubRelease; zip?: Buffer; error?: Error } = {},
): ImportClient {
  return {
    async getLatestRelease() {
      if (options.error) throw options.error;
      if (!options.release) throw new Error("no release fixture");
      return options.release;
    },
    async downloadAsset() {
      if (!options.zip) throw new Error("no zip fixture");
      return new Response(options.zip);
    },
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  ownerId = await makeAccount("owner");
  strangerId = await makeAccount("stranger");

  await db.insert(githubInstallations).values([
    { installationId: INSTALL, accountId: ownerId, accountLogin: "acme" },
    {
      installationId: STRANGER_INSTALL,
      accountId: strangerId,
      accountLogin: "other",
    },
  ]);
  await db.insert(githubRepos).values([
    { repoId: REPO, installationId: INSTALL, fullName: "acme/ext" },
    { repoId: OTHER_REPO, installationId: INSTALL, fullName: "acme/other" },
    { repoId: STRANGER_REPO, installationId: STRANGER_INSTALL, fullName: "other/ext" },
  ]);

  productId = await makeProduct({
    extensionId: "sforum.alpha",
    ownerAccountId: ownerId,
    slug: "alpha",
  });
});

afterAll(async () => {
  await closeDb();
});

describe("bindProductRepo", () => {
  test("binds the repository, records how, and audits the change", async () => {
    const detail = await bindProductRepo(db, {
      accountId: ownerId,
      productId,
      repoId: REPO,
      ip: "203.0.113.9",
    });

    expect(detail.repoId).toBe(REPO);
    expect(detail.repoBoundVia).toBe("installation");
    expect(detail.repoBoundAt).not.toBeNull();
    expect(await auditActions(productId)).toEqual(["product.repo_bound"]);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "product.repo_bound"));
    expect(audit?.actorAccountId).toBe(ownerId);
    expect(audit?.ip).toBe("203.0.113.9");
    expect(audit?.details).toMatchObject({
      repoId: REPO,
      repoFullName: "acme/ext",
      previousRepoId: null,
      via: "installation",
    });
  });

  test("re-binding the same repository is idempotent and writes no second audit row", async () => {
    await bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO });
    await bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO });
    expect(await auditActions(productId)).toEqual(["product.repo_bound"]);
  });

  test("moving to another repository is allowed and audited with the previous id", async () => {
    await bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO });
    const detail = await bindProductRepo(db, {
      accountId: ownerId,
      productId,
      repoId: OTHER_REPO,
    });
    expect(detail.repoId).toBe(OTHER_REPO);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "product.repo_bound"));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.details).toMatchObject({ previousRepoId: REPO });
  });

  test("a repository behind another account's installation is a 404", async () => {
    await expect(
      bindProductRepo(db, { accountId: ownerId, productId, repoId: STRANGER_REPO }),
    ).rejects.toMatchObject({ code: "repo_not_bindable", status: 404 });
  });

  test("an archived repository is refused with its own code", async () => {
    await db.update(githubRepos).set({ archived: true }).where(eq(githubRepos.repoId, REPO));
    await expect(
      bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO }),
    ).rejects.toMatchObject({ code: "repo_archived", status: 409 });
  });

  test("another account's product is a 404, never a 403", async () => {
    await expect(
      bindProductRepo(db, { accountId: strangerId, productId, repoId: REPO }),
    ).rejects.toMatchObject({ code: "product_not_found", status: 404 });
  });

  test("a pending claim for the same repository and extension id is answered by the binding", async () => {
    await recordClaim(db, {
      repoId: REPO,
      installationId: INSTALL,
      extensionId: "sforum.alpha",
      manifestName: "Alpha",
      tag: "v1.0.0",
      githubReleaseId: 11,
    });

    await bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO });

    const [claim] = await db.select().from(repoClaims);
    expect(claim?.state).toBe("claimed");
    expect(claim?.claimedProductId).toBe(productId);
    expect(claim?.claimedByAccountId).toBe(ownerId);
  });
});

describe("unbindProductRepo", () => {
  test("clears the binding on a draft and audits it", async () => {
    await bindProductRepo(db, { accountId: ownerId, productId, repoId: REPO });
    const detail = await unbindProductRepo(db, { accountId: ownerId, productId });

    expect(detail.repoId).toBeNull();
    expect(detail.repoBoundAt).toBeNull();
    expect(detail.repoBoundVia).toBeNull();
    expect(await auditActions(productId)).toEqual([
      "product.repo_bound",
      "product.repo_unbound",
    ]);
  });

  test("a published product keeps its repository", async () => {
    await db
      .update(products)
      .set({ status: "published", repoId: REPO })
      .where(eq(products.id, productId));
    await expect(
      unbindProductRepo(db, { accountId: ownerId, productId }),
    ).rejects.toMatchObject({ code: "repo_binding_locked", status: 409 });
  });

  test("unbinding an already unbound product is a no-op", async () => {
    const detail = await unbindProductRepo(db, { accountId: ownerId, productId });
    expect(detail.repoId).toBeNull();
    expect(await auditActions(productId)).toEqual([]);
  });
});

describe("loadRepoBinding", () => {
  test("reads the repository row behind a binding", async () => {
    expect(await loadRepoBinding(db, REPO)).toEqual({
      repoId: REPO,
      fullName: "acme/ext",
      private: false,
      archived: false,
      upstreamState: "connected",
      installationLogin: "acme",
    });
  });

  test("an unknown repository id is null", async () => {
    expect(await loadRepoBinding(db, 999_999)).toBeNull();
  });
});

describe("importProductFromRepo", () => {
  async function zipFor(manifest: Record<string, unknown>): Promise<Buffer> {
    return makeZip({
      "sforum.extension.json": JSON.stringify(manifest),
      "backend/plugin": elfHeader(),
    });
  }

  test("creates the product from the release manifest, binds it and syncs the version", async () => {
    const zip = await zipFor({ ...pluginManifest, id: "sforum.imported" });
    const result = await importProductFromRepo(db, {
      accountId: ownerId,
      repoId: REPO,
      client: fakeClient({ release: releaseWith(zip), zip }),
    });

    expect(result.created).toBe(true);
    expect(result.product.extensionId).toBe("sforum.imported");
    expect(result.product.name).toBe("Markdown Plus");
    expect(result.product.kind).toBe("plugin");
    expect(result.product.repoId).toBe(REPO);
    expect(result.product.repoBoundVia).toBe("installation");
    expect(result.issues).toEqual([]);

    // The release is synced in the same call, so the product is not born empty.
    const versions = await db
      .select()
      .from(releaseVersions)
      .where(eq(releaseVersions.productId, result.product.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe("1.4.2");
    expect(versions[0]?.state).toBe("pending_review");

    expect(await auditActions(result.product.id)).toEqual(["product.repo_imported"]);
  });

  test("a second import adopts the existing unbound product instead of failing", async () => {
    const zip = await zipFor({ ...pluginManifest, id: "sforum.alpha" });
    const result = await importProductFromRepo(db, {
      accountId: ownerId,
      repoId: REPO,
      client: fakeClient({ release: releaseWith(zip), zip }),
    });

    expect(result.created).toBe(false);
    expect(result.product.id).toBe(productId);
    expect(result.product.repoId).toBe(REPO);
    expect(await auditActions(productId)).toEqual(["product.repo_adopted"]);
  });

  test("a repository with no release answers repo_has_no_release", async () => {
    await expect(
      importProductFromRepo(db, {
        accountId: ownerId,
        repoId: REPO,
        client: fakeClient({ error: new GithubError(404, "Not Found") }),
      }),
    ).rejects.toMatchObject({ code: "repo_has_no_release", status: 409 });
  });

  test("a release without a ZIP asset answers repo_release_has_no_zip", async () => {
    const release = releaseWith(Buffer.from("x"), "notes.txt");
    await expect(
      importProductFromRepo(db, {
        accountId: ownerId,
        repoId: REPO,
        client: fakeClient({ release, zip: Buffer.from("x") }),
      }),
    ).rejects.toMatchObject({ code: "repo_release_has_no_zip", status: 409 });
  });

  test("an extension id owned by another account is a conflict", async () => {
    await makeProduct({
      extensionId: "sforum.owned-elsewhere",
      ownerAccountId: strangerId,
      slug: "owned-elsewhere",
    });
    const zip = await zipFor({ ...pluginManifest, id: "sforum.owned-elsewhere" });

    await expect(
      importProductFromRepo(db, {
        accountId: ownerId,
        repoId: REPO,
        client: fakeClient({ release: releaseWith(zip), zip }),
      }),
    ).rejects.toMatchObject({ code: "extension_id_taken", status: 409 });
  });

  test("an extension id already bound to another repository is a conflict", async () => {
    await makeProduct({
      extensionId: "sforum.bound-elsewhere",
      ownerAccountId: ownerId,
      repoId: OTHER_REPO,
      slug: "bound-elsewhere",
    });
    const zip = await zipFor({ ...pluginManifest, id: "sforum.bound-elsewhere" });

    await expect(
      importProductFromRepo(db, {
        accountId: ownerId,
        repoId: REPO,
        client: fakeClient({ release: releaseWith(zip), zip }),
      }),
    ).rejects.toMatchObject({ code: "extension_id_bound_elsewhere", status: 409 });
  });

  test("an unreadable repository is a 404 before any GitHub call", async () => {
    const client: ImportClient = {
      async getLatestRelease() {
        throw new Error("must not be called");
      },
      async downloadAsset() {
        throw new Error("must not be called");
      },
    };
    const error = await importProductFromRepo(db, {
      accountId: ownerId,
      repoId: STRANGER_REPO,
      client,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProductError);
    expect(error).toMatchObject({ code: "repo_not_bindable", status: 404 });
  });
});

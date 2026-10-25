import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { accounts, githubInstallations, githubRepos } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import type { GithubRepository } from "./client";
import {
  findBindableRepo,
  GithubRepoError,
  listAccountInstallations,
  listSelectableRepos,
  syncInstallationRepos,
  type RepoListerClient,
} from "./repos";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;
let ownerId: string;
let strangerId: string;

const OWN_INSTALL = 501;
const SUSPENDED_INSTALL = 502;
const DELETED_INSTALL = 503;
const STRANGER_INSTALL = 504;

async function makeAccount(sub: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ issuerKey: "test", sub, username: sub })
    .returning({ id: accounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function makeInstallation(input: {
  installationId: number;
  accountId: string | null;
  login: string;
  status?: "active" | "suspended" | "deleted";
}): Promise<void> {
  await db.insert(githubInstallations).values({
    installationId: input.installationId,
    accountId: input.accountId,
    accountLogin: input.login,
    status: input.status ?? "active",
  });
}

async function makeRepo(input: {
  repoId: number;
  installationId: number;
  fullName: string;
  archived?: boolean;
  upstreamState?: "connected" | "degraded" | "disconnected";
}): Promise<void> {
  await db.insert(githubRepos).values({
    repoId: input.repoId,
    installationId: input.installationId,
    fullName: input.fullName,
    archived: input.archived ?? false,
    upstreamState: input.upstreamState ?? "connected",
  });
}

function repo(id: number, fullName: string): GithubRepository {
  return {
    id,
    full_name: fullName,
    private: false,
    archived: false,
    default_branch: "main",
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

  await makeInstallation({ installationId: OWN_INSTALL, accountId: ownerId, login: "acme" });
  await makeInstallation({
    installationId: SUSPENDED_INSTALL,
    accountId: ownerId,
    login: "acme-suspended",
    status: "suspended",
  });
  await makeInstallation({
    installationId: DELETED_INSTALL,
    accountId: ownerId,
    login: "acme-deleted",
    status: "deleted",
  });
  await makeInstallation({
    installationId: STRANGER_INSTALL,
    accountId: strangerId,
    login: "someone-else",
  });

  await makeRepo({ repoId: 1, installationId: OWN_INSTALL, fullName: "acme/alpha" });
  await makeRepo({ repoId: 2, installationId: OWN_INSTALL, fullName: "acme/beta" });
  await makeRepo({ repoId: 3, installationId: SUSPENDED_INSTALL, fullName: "acme/gamma" });
  await makeRepo({ repoId: 4, installationId: DELETED_INSTALL, fullName: "acme/delta" });
  await makeRepo({ repoId: 5, installationId: STRANGER_INSTALL, fullName: "other/epsilon" });
  await makeRepo({
    repoId: 6,
    installationId: OWN_INSTALL,
    fullName: "acme/zeta",
    upstreamState: "disconnected",
  });
});

afterAll(async () => {
  await closeDb();
});

describe("listAccountInstallations", () => {
  test("omits deleted installations and counts mirrored repositories", async () => {
    const rows = await listAccountInstallations(db, ownerId);
    expect(rows.map((row) => row.installationId)).toEqual([
      OWN_INSTALL,
      SUSPENDED_INSTALL,
    ]);
    const own = rows.find((row) => row.installationId === OWN_INSTALL);
    expect(own?.status).toBe("active");
    // alpha, beta, zeta — a disconnected repository still belongs to the installation.
    expect(own?.repoCount).toBe(3);
    expect(rows.find((row) => row.installationId === SUSPENDED_INSTALL)?.status).toBe(
      "suspended",
    );
  });

  test("another account's installation is not listed", async () => {
    const rows = await listAccountInstallations(db, strangerId);
    expect(rows.map((row) => row.installationId)).toEqual([STRANGER_INSTALL]);
  });

  test("an account with no installation gets an empty list", async () => {
    expect(await listAccountInstallations(db, "11111111-1111-4111-8111-111111111111")).toEqual(
      [],
    );
  });
});

describe("listSelectableRepos", () => {
  test("returns only repositories behind the account's active installations", async () => {
    const rows = await listSelectableRepos(db, ownerId);
    expect(rows.map((row) => row.fullName)).toEqual(["acme/alpha", "acme/beta"]);
  });

  test("a disconnected repository is not offered", async () => {
    const rows = await listSelectableRepos(db, ownerId);
    expect(rows.some((row) => row.fullName === "acme/zeta")).toBe(false);
  });

  test("an archived repository stays listed so the picker can explain why it is disabled", async () => {
    await db.update(githubRepos).set({ archived: true }).where(eq(githubRepos.repoId, 2));
    const rows = await listSelectableRepos(db, ownerId);
    expect(rows.find((row) => row.repoId === 2)?.archived).toBe(true);
  });
});

describe("findBindableRepo", () => {
  test("resolves a repository behind an active installation of the account", async () => {
    expect(await findBindableRepo(db, ownerId, 1)).toEqual({
      repoId: 1,
      installationId: OWN_INSTALL,
      fullName: "acme/alpha",
      archived: false,
    });
  });

  test("an unknown repository id is null", async () => {
    expect(await findBindableRepo(db, ownerId, 999)).toBeNull();
  });

  test("someone else's repository is null, not a 403", async () => {
    expect(await findBindableRepo(db, ownerId, 5)).toBeNull();
  });

  test("a suspended installation offers nothing", async () => {
    expect(await findBindableRepo(db, ownerId, 3)).toBeNull();
  });

  test("a deleted installation offers nothing", async () => {
    expect(await findBindableRepo(db, ownerId, 4)).toBeNull();
  });

  test("a disconnected repository cannot be bound", async () => {
    expect(await findBindableRepo(db, ownerId, 6)).toBeNull();
  });
});

describe("syncInstallationRepos", () => {
  function fakeClient(pages: GithubRepository[][], totalCount: number) {
    const calls: number[] = [];
    const client: RepoListerClient = {
      async listInstallationRepositories(_installationId, page = 1) {
        calls.push(page);
        return {
          totalCount,
          repositories: pages[page - 1] ?? [],
        };
      },
    };
    return { client, calls };
  }

  test("walks every page and mirrors each repository once", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      repo(1_000 + index, `acme/page-a-${index}`),
    );
    const second = Array.from({ length: 20 }, (_, index) =>
      repo(2_000 + index, `acme/page-b-${index}`),
    );
    const fake = fakeClient([first, second], 120);

    expect(await syncInstallationRepos(db, fake.client, OWN_INSTALL)).toBe(120);
    expect(fake.calls).toEqual([1, 2]);

    const rows = await db
      .select()
      .from(githubRepos)
      .where(eq(githubRepos.installationId, OWN_INSTALL));
    // Three seeded rows plus the 120 mirrored ones.
    expect(rows).toHaveLength(123);
    // Mirroring only ever writes `connected`; the seeded disconnected row stays as it was.
    const mirrored = rows.filter((row) => row.repoId >= 1_000);
    expect(mirrored).toHaveLength(120);
    expect(mirrored.every((row) => row.upstreamState === "connected")).toBe(true);
  });

  test("stops after one short page", async () => {
    const fake = fakeClient([[repo(3_001, "acme/only")]], 1);
    expect(await syncInstallationRepos(db, fake.client, OWN_INSTALL)).toBe(1);
    expect(fake.calls).toEqual([1]);
  });

  test("refuses an installation that outgrows the page budget instead of truncating", async () => {
    const fullPages = Array.from({ length: 10 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) =>
        repo(4_000 + page * 100 + index, `acme/big-${page}-${index}`),
      ),
    );
    const fake = fakeClient(fullPages, 1_200);

    await expect(
      syncInstallationRepos(db, fake.client, OWN_INSTALL),
    ).rejects.toBeInstanceOf(GithubRepoError);
  });
});

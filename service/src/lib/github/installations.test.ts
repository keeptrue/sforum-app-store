import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { githubInstallations } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { recordInstallation } from "./installations";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

let db: Db;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  await getPool().query(TRUNCATE_ALL);
});

afterAll(async () => {
  await closeDb();
});

describe("recordInstallation", () => {
  test("upserts once and updates the login on replay", async () => {
    await recordInstallation(db, {
      installationId: 77,
      accountId: null,
      accountLogin: "acme",
    });
    await recordInstallation(db, {
      installationId: 77,
      accountId: null,
      accountLogin: "acme-renamed",
    });

    const rows = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 77));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountLogin).toBe("acme-renamed");
    expect(rows[0]?.status).toBe("active");
  });
});

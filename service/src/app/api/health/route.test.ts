import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { GET } from "./route";
import { closeDb, getDb, getPool } from "@/db/client";
import { resetConfigForTests } from "@/lib/config";
import { resetRuntimeConfigForTests } from "@/lib/settings/runtime";

const key = Buffer.alloc(32, 3).toString("base64");
const saved = { ...process.env };

// 与其它 Postgres 集成用例一致：CI 用 service 的 TEST_DATABASE_URL，本机走默认测试库。
// 这条用例读的是 `store_settings` 行，必须自己准备库状态：`STORE_PUBLIC_URL` 只是种子，
// 保存过的那行优先（`lib/config.ts` 的 publicUrlSeed 注释 + `lib/settings/runtime.ts`）。
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

function setEnv() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = "https://store.example.com";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `k1:${key}`;
  resetConfigForTests();
}

beforeAll(async () => {
  setEnv();
  await migrate(getDb(), {
    migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  setEnv();
  // 每个用例从「没有保存过设置」开始：这是 env 种子生效的前提，也避免别的套件
  // 留下的那一行决定这里的断言。
  await getPool().query("delete from store_settings");
  resetRuntimeConfigForTests();
});

afterEach(() => {
  process.env = { ...saved };
  resetConfigForTests();
  resetRuntimeConfigForTests();
});

afterAll(async () => {
  await getPool().query("delete from store_settings");
  await closeDb();
  resetConfigForTests();
  resetRuntimeConfigForTests();
});

describe("GET /api/health", () => {
  test("reports the env seed and cookie shape when nothing is saved", async () => {
    const body = await (await GET()).json();

    expect(body.status).toBe("ok");
    expect(body.publicUrl).toBe("https://store.example.com");
    expect(body.publicUrlSource).toBe("env");
    expect(body.sessionCookie).toBe("__Host-store_session");
    expect(body.cookieSecure).toBe(true);
    expect(body.nodeEnv).toBe("test");
    expect(body.configError).toBeUndefined();
  });

  test("mirrors a loopback public URL instead of hiding it", async () => {
    process.env.STORE_PUBLIC_URL = "http://127.0.0.1:4000";
    resetConfigForTests();

    const body = await (await GET()).json();

    expect(body.publicUrl).toBe("http://127.0.0.1:4000");
    expect(body.publicUrlSource).toBe("env");
    expect(body.sessionCookie).toBe("store_session");
    expect(body.cookieSecure).toBe(false);
  });

  // 设计意图：STORE_PUBLIC_URL 只是种子，后台保存的那行优先。CI 里别的套件遗留的行
  // 曾让上面两条假红——这里把优先级本身钉住，而不是依赖库里恰好没有那一行。
  test("a saved settings row wins over the env seed", async () => {
    await getPool().query(
      `insert into store_settings (id, public_url) values ('default', 'https://saved.example.com')`,
    );
    resetRuntimeConfigForTests();

    const body = await (await GET()).json();

    expect(body.publicUrl).toBe("https://saved.example.com");
    expect(body.publicUrlSource).toBe("database");
    expect(body.sessionCookie).toBe("__Host-store_session");
    expect(body.cookieSecure).toBe(true);
    expect(body.configError).toBeUndefined();
  });

  test("stays a liveness probe when configuration is unreadable", async () => {
    delete process.env.STORE_PUBLIC_URL;
    resetConfigForTests();

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.configError).toContain("STORE_PUBLIC_URL");
    expect(body.publicUrl).toBeUndefined();
  });
});

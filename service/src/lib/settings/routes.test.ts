import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { storeSettings } from "@/db/schema";
import { registerFirstAdmin } from "@/lib/admin/setup";
import { createAdminSession } from "@/lib/admin/session";
import { getConfig, resetConfigForTests, type StoreConfig } from "@/lib/config";
import { resetRuntimeConfigForTests } from "@/lib/settings/runtime";
import { TRUNCATE_ALL } from "@/lib/test-support/db";

/**
 * The HTTP surface of 系统设置: who may call it, what a bad value looks like, and that the two
 * confirmation gates come back as 409 with the consequence spelled out.
 *
 * The domain behaviour (what the row ends up holding) is covered in `service.test.ts`; here the
 * subject is the transport contract the form codes against.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test";

const PUBLIC_URL = "http://127.0.0.1:3000";
const SETUP_TOKEN = "setup-token-for-tests-0123456789";

let adminToken: string | null = null;

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      adminToken && name === "store_admin_session"
        ? { name, value: adminToken }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers({ host: "127.0.0.1:3000" }),
}));

type SettingsRoute = {
  GET: (request: Request) => Promise<Response>;
  PUT: (request: Request) => Promise<Response>;
  DELETE: (request: Request) => Promise<Response>;
};

let route: SettingsRoute;
let db: Db;
let config: StoreConfig;

function request(init: RequestInit & { origin?: string; host?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("host", init.host ?? "127.0.0.1:3000");
  if (init.origin !== undefined) headers.set("origin", init.origin);
  return new Request(`${PUBLIC_URL}/api/admin/settings`, { ...init, headers });
}

function body(value: unknown, options: { origin?: string; host?: string } = {}): RequestInit & {
  origin?: string;
  host?: string;
} {
  return {
    method: "PUT",
    body: JSON.stringify(value),
    origin: options.origin ?? PUBLIC_URL,
    host: options.host,
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.STORE_PUBLIC_URL = PUBLIC_URL;
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `test1:${Buffer.alloc(32, 3).toString("base64")}`;
  process.env.STORE_ADMIN_SETUP_TOKEN = SETUP_TOKEN;
  resetConfigForTests();
  resetRuntimeConfigForTests();

  config = getConfig();
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
  route = await import("@/app/api/admin/settings/route");
});

beforeEach(async () => {
  await getPool().query(TRUNCATE_ALL);
  resetRuntimeConfigForTests();
  const admin = await registerFirstAdmin(db, config, {
    token: SETUP_TOKEN,
    username: "root",
    password: "initial-password-123",
  });
  const session = await createAdminSession(db, admin.id, {
    ttlSeconds: 8 * 60 * 60,
  });
  adminToken = session.token;
});

afterAll(async () => {
  await closeDb();
  resetConfigForTests();
  resetRuntimeConfigForTests();
  delete process.env.STORE_ADMIN_SETUP_TOKEN;
});

describe("GET /api/admin/settings", () => {
  test("401 without an admin session", async () => {
    adminToken = null;
    const response = await route.GET(request());
    expect(response.status).toBe(401);
  });

  test("returns the effective view with its source", async () => {
    const response = await route.GET(request());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      settings: { publicUrl: string; publicUrlSource: string; rateLimits: unknown[] };
    };
    expect(payload.settings.publicUrl).toBe(PUBLIC_URL);
    expect(payload.settings.publicUrlSource).toBe("env");
    expect(payload.settings.rateLimits.length).toBe(6);
  });
});

describe("PUT /api/admin/settings", () => {
  test("403 for a cross-origin mutation", async () => {
    const response = await route.PUT(
      request(body({ publicUrl: PUBLIC_URL }, { origin: "https://evil.example" })),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("cross_origin");
  });

  test("401 without an admin session", async () => {
    adminToken = null;
    const response = await route.PUT(request(body({ publicUrl: PUBLIC_URL })));
    expect(response.status).toBe(401);
  });

  test("400 for a public URL that is not a URL", async () => {
    const response = await route.PUT(request(body({ publicUrl: "store.example.com" })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_public_url");
  });

  test("400 for a missing public URL", async () => {
    const response = await route.PUT(request(body({})));
    expect(response.status).toBe(400);
  });

  test("saves the download mode and reports which layer answers", async () => {
    const response = await route.PUT(
      request(body({ publicUrl: PUBLIC_URL, downloadMode: "redirect" })),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      settings: { downloadMode: string; downloadModeSource: string; seedDownloadMode: string };
    };
    expect(payload.settings.downloadMode).toBe("redirect");
    expect(payload.settings.downloadModeSource).toBe("database");
    expect(payload.settings.seedDownloadMode).toBe("proxy");
  });

  test("400 for a download mode the runtime does not have", async () => {
    const response = await route.PUT(
      request(body({ publicUrl: PUBLIC_URL, downloadMode: "mirror" })),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_download_mode");
  });

  test("409 while the new origin differs from the request origin", async () => {
    const response = await route.PUT(
      request(body({ publicUrl: "https://new.example.com" })),
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { code: string; message: string };
    expect(payload.code).toBe("confirm_origin_change");
    expect(payload.message).toContain("https://new.example.com");
  });

  test("saves with the confirmation and answers with the effective value", async () => {
    const response = await route.PUT(
      request(
        body({
          publicUrl: "https://new.example.com",
          downloadTtlSeconds: 900,
          rateLimits: { login: "4/120" },
          // Both gates apply when the host and the scheme move at once; the form accumulates
          // confirmations for exactly this case.
          confirmOriginChange: true,
          confirmInsecureTransition: true,
        }),
      ),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: true;
      changed: boolean;
      settings: {
        publicUrl: string;
        publicUrlSource: string;
        downloadTtlSeconds: number;
        derived: { callbackUrl: string };
        rateLimits: Array<{ channel: string; effective: string }>;
      };
    };
    expect(payload.changed).toBe(true);
    expect(payload.settings.publicUrl).toBe("https://new.example.com");
    expect(payload.settings.publicUrlSource).toBe("database");
    expect(payload.settings.downloadTtlSeconds).toBe(900);
    expect(payload.settings.derived.callbackUrl).toBe(
      "https://new.example.com/api/auth/sforum/callback",
    );
    expect(
      payload.settings.rateLimits.find((row) => row.channel === "login")?.effective,
    ).toBe("4/120");
  });

  test("409 when switching to https from an http request", async () => {
    // Same origin, only the scheme changes: the cookie prefix would move to __Host- and the
    // browser would drop it over plain http.
    const response = await route.PUT(
      request(
        body(
          { publicUrl: "https://127.0.0.1:3000", confirmOriginChange: true },
          { origin: PUBLIC_URL, host: "127.0.0.1:3000" },
        ),
      ),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe(
      "confirm_insecure_transition",
    );
  });
});

describe("DELETE /api/admin/settings", () => {
  test("drops the row and returns to the seed", async () => {
    await route.PUT(
      request(
        body({ publicUrl: "https://new.example.com", confirmOriginChange: true }),
      ),
    );

    const response = await route.DELETE(request({ method: "DELETE", origin: PUBLIC_URL }));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      settings: { publicUrl: string; publicUrlSource: string };
    };
    expect(payload.settings.publicUrl).toBe(PUBLIC_URL);
    expect(payload.settings.publicUrlSource).toBe("env");
    expect((await db.select({ id: storeSettings.id }).from(storeSettings)).length).toBe(0);
  });

  test("403 for a cross-origin delete", async () => {
    const response = await route.DELETE(
      request({ method: "DELETE", origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });
});

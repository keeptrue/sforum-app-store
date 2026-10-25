import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GET } from "./route";
import { resetConfigForTests } from "@/lib/config";

const key = Buffer.alloc(32, 3).toString("base64");
const saved = { ...process.env };

function setEnv() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgres://store:store@127.0.0.1:5432/store";
  process.env.STORE_PUBLIC_URL = "https://store.example.com";
  process.env.STORE_SESSION_SECRET = "s".repeat(64);
  process.env.STORE_DOWNLOAD_SECRET = "d".repeat(64);
  process.env.STORE_SECRET_KEYS = `k1:${key}`;
  resetConfigForTests();
}

beforeEach(() => setEnv());

afterEach(() => {
  process.env = { ...saved };
  resetConfigForTests();
});

describe("GET /api/health", () => {
  test("reports the resolved public URL and cookie shape", async () => {
    const body = await (await GET()).json();

    expect(body.status).toBe("ok");
    expect(body.publicUrl).toBe("https://store.example.com");
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
    expect(body.sessionCookie).toBe("store_session");
    expect(body.cookieSecure).toBe(false);
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

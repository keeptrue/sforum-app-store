import { afterAll, describe, expect, test } from "bun:test";

import { getBoss, stopBoss } from "./queue";

/**
 * The module keeps one `PgBoss` per process. A failed start must not be remembered, or every
 * later `enqueue` replays that rejection and the webhook route answers 500 until a restart.
 *
 * The test never needs a working database: two dead ports are enough, because the question is
 * *which attempt* failed. A cached rejection would report the first port on both calls.
 */
describe("getBoss", () => {
  const original = process.env.DATABASE_URL;

  afterAll(async () => {
    await stopBoss();
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  test("a failed start is not cached", async () => {
    const attempt = async (url: string): Promise<string> => {
      process.env.DATABASE_URL = url;
      try {
        await getBoss();
        return "connected";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const first = await attempt(
      "postgres://store:store_dev_only@127.0.0.1:1/sforum_store",
    );
    const second = await attempt(
      "postgres://store:store_dev_only@127.0.0.1:2/sforum_store",
    );

    expect(first).toContain("127.0.0.1:1");
    expect(second).toContain("127.0.0.1:2");
  });
});

import { describe, expect, test } from "bun:test";

import { decodeCursor, encodeCursor } from "./cursor";

function tokenFor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("catalog cursor", () => {
  test("round-trips an instant and an id", () => {
    const updatedAt = new Date("2026-10-01T12:34:56.789Z");
    const id = "0b0c1d2e-1111-4222-8333-444455556666";
    const token = encodeCursor({ updatedAt, id });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = decodeCursor(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.updatedAt.toISOString()).toBe("2026-10-01T12:34:56.789Z");
    expect(decoded?.id).toBe(id);
  });

  test("does not leak the payload as plain JSON", () => {
    const token = encodeCursor({ updatedAt: new Date("2026-10-01T00:00:00.000Z"), id: "abc" });
    const raw = Buffer.from(token, "base64url").toString("utf8");
    expect(raw).toBe('{"u":"2026-10-01T00:00:00.000Z","i":"abc"}');
  });

  test("rejects garbage", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor("bm90IGpzb24")).toBeNull();
    expect(decodeCursor(tokenFor([]))).toBeNull();
    expect(decodeCursor(tokenFor(null))).toBeNull();
    expect(decodeCursor(tokenFor("string"))).toBeNull();
  });

  test("rejects a decoded object with the wrong shape", () => {
    expect(decodeCursor(tokenFor({}))).toBeNull();
    expect(decodeCursor(tokenFor({ u: "2026-10-01T00:00:00.000Z" }))).toBeNull();
    expect(decodeCursor(tokenFor({ i: "abc" }))).toBeNull();
    expect(decodeCursor(tokenFor({ u: "not-a-date", i: "abc" }))).toBeNull();
    expect(decodeCursor(tokenFor({ u: 1234, i: "abc" }))).toBeNull();
    expect(decodeCursor(tokenFor({ u: "2026-10-01T00:00:00.000Z", i: "" }))).toBeNull();
    expect(decodeCursor(tokenFor({ u: "2026-10-01T00:00:00.000Z", i: 42 }))).toBeNull();
  });

  test("requires an ISO instant rather than any parseable string", () => {
    expect(decodeCursor(tokenFor({ u: "2026-10-01", i: "abc" }))).toBeNull();
    expect(decodeCursor(tokenFor({ u: "October 1 2026", i: "abc" }))).toBeNull();
  });
});

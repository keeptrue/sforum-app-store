import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { LocalAssetStore } from "./local";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sforum-asset-store-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("LocalAssetStore.key", () => {
  test("shards the digest two levels deep", () => {
    const digest = "ab".repeat(32);
    expect(LocalAssetStore.key(digest)).toBe(`ab/ab/${digest}`);
  });

  test("rejects short, uppercase and non-hex digests", () => {
    for (const value of ["", "abc", "AB".repeat(32), "zz".repeat(32)]) {
      expect(() => LocalAssetStore.key(value)).toThrow();
    }
  });
});

describe("LocalAssetStore", () => {
  test("put stores bytes under the content-addressed key", async () => {
    const store = new LocalAssetStore(root);
    const bytes = Buffer.from("first image bytes");
    const result = await store.put(bytes);

    expect(result.created).toBe(true);
    expect(result.sha256).toBe(sha256Of(bytes));
    expect(result.storageKey).toBe(LocalAssetStore.key(result.sha256));
    expect(await store.exists(result.storageKey)).toBe(true);

    const onDisk = await stat(join(root, result.storageKey));
    expect(onDisk.size).toBe(bytes.length);
  });

  test("put is idempotent and leaves no temp files behind", async () => {
    const store = new LocalAssetStore(root);
    const bytes = Buffer.from("second image bytes");
    const first = await store.put(bytes);
    const second = await store.put(bytes);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.storageKey).toBe(first.storageKey);

    const directory = join(root, first.storageKey, "..");
    const entries = await readdir(directory);
    expect(entries).toEqual([first.sha256]);

    // A fresh instance (as a new process would) sees the same content.
    const reopened = await new LocalAssetStore(root).put(bytes);
    expect(reopened.created).toBe(false);
  });

  test("read round-trips bytes and returns null for missing keys", async () => {
    const store = new LocalAssetStore(root);
    const bytes = Buffer.from("round trip");
    const { storageKey } = await store.put(bytes);

    const read = await store.read(storageKey);
    expect(read?.equals(Buffer.from(bytes))).toBe(true);

    expect(await store.read(LocalAssetStore.key("0".repeat(64)))).toBeNull();
    expect(await store.read("not-a-key")).toBeNull();
  });

  test("read and exists refuse traversal-shaped keys", async () => {
    const store = new LocalAssetStore(root);
    const digest = sha256Of(Buffer.from("traversal"));

    const hostile = [
      `../../${digest}`,
      `/etc/passwd`,
      `ab/cd/../../${digest}`,
      `ab\\cd\\${digest}`,
      `${digest}/../${digest}`,
      `ab/cd/${digest}\0.png`,
      `ab/cd/not-a-digest`,
      `ab/cd/${digest.slice(0, 63)}`,
    ];

    for (const key of hostile) {
      expect(await store.read(key)).toBeNull();
      expect(await store.exists(key)).toBe(false);
    }
  });

  test("writes create nested shard directories", async () => {
    const store = new LocalAssetStore(join(root, "nested", "root"));
    const { storageKey, created } = await store.put(Buffer.from("nested"));
    expect(created).toBe(true);
    expect(await store.exists(storageKey)).toBe(true);
  });
});

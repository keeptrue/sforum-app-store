import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  AssetFetchError,
  MAX_ASSET_BYTES,
  downloadReleaseAsset,
  writeAssetBody,
} from "./assets";

/** A body that keeps producing 1 MiB chunks until it has passed `bytes`. */
function oversizedBody(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  const total = Math.ceil(bytes / chunk.length);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(chunk);
    },
  });
}

describe("writeAssetBody", () => {
  test("a destination that cannot be opened rejects instead of crashing the process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sforum-assets-test-"));
    try {
      // The parent directory does not exist, so `createWriteStream` fails asynchronously —
      // the exact shape that used to take the process down: the first chunk is under the
      // high-water mark, `write()` answers `true`, nothing awaits, and the `error` event has
      // no listener.
      const body = new Response(Buffer.alloc(1024)).body!;
      let thrown: unknown = null;
      try {
        await writeAssetBody(body, join(dir, "missing", "asset.zip"), 1024);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AssetFetchError);
      // A local write failure is an infrastructure hiccup, not a verdict about the release.
      expect((thrown as AssetFetchError).retryable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes the body, counts it and hashes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sforum-assets-test-"));
    try {
      const data = Buffer.from("release bytes");
      const written = await writeAssetBody(
        new Response(data).body!,
        join(dir, "asset.zip"),
        data.length,
      );

      expect(written.size).toBe(data.length);
      expect(written.sha256).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
      expect(await readFile(join(dir, "asset.zip"))).toEqual(data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a short body is a retryable transfer failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sforum-assets-test-"));
    try {
      let thrown: unknown = null;
      try {
        await writeAssetBody(
          new Response(Buffer.from("short")).body!,
          join(dir, "asset.zip"),
          4096,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AssetFetchError);
      expect((thrown as AssetFetchError).retryable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an oversized asset is a permanent failure and leaves no temp directory", async () => {
    // `os.tmpdir()` reads TMPDIR per call, so pointing it at a directory we own is how the
    // cleanup promise becomes observable: after the failure that directory has to be empty.
    const root = await mkdtemp(join(tmpdir(), "sforum-assets-root-"));
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const client = {
        downloadAsset: async () =>
          new Response(oversizedBody(MAX_ASSET_BYTES + 1)),
      };
      let thrown: unknown = null;
      try {
        await downloadReleaseAsset(client, "example/repo", 1, {
          id: 1,
          name: "too-big.zip",
          size: 0,
          content_type: "application/zip",
          browser_download_url: "https://example.test/too-big.zip",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AssetFetchError);
      // A policy ceiling, not a transport problem: the next attempt downloads the same
      // oversized file. Flipping this to `true` would spend retries on a certain failure.
      expect((thrown as AssetFetchError).retryable).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await rm(root, { recursive: true, force: true });
    }
  });
});

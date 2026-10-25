import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  elfHeader,
  makeZip,
  pluginManifest,
  themeManifest,
} from "../../../test/zip-fixture";
import { readExtensionZip } from "./zip";

async function withZip<T>(
  zip: Buffer,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sforum-zip-test-"));
  const path = join(dir, "asset.zip");
  await writeFile(path, zip);
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("readExtensionZip", () => {
  test("reads a manifest and backend entry", async () => {
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
      "backend/plugin": elfHeader(),
    });

    await withZip(zip, async (path) => {
      const result = await readExtensionZip(path);
      expect(result.manifest.id).toBe("sforum.markdown-plus");
      expect(result.manifest.backend?.entry).toBe("backend/plugin");
      expect(result.backend?.subarray(0, 4)).toEqual(
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      );
      expect(result.entryCount).toBe(2);
    });
  });

  test("rejects a manifest that only exists in a subdirectory", async () => {
    const zip = await makeZip({
      "package/sforum.extension.json": JSON.stringify(pluginManifest),
      "package/backend/plugin": elfHeader(),
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "manifest_not_at_root",
      });
    });
  });

  test("ignores a nested manifest when the root one is present", async () => {
    // The host reads the root manifest and treats the nested copy as a plain package
    // file, so the store must not call this ambiguous.
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
      "docs/sforum.extension.json": JSON.stringify({
        ...pluginManifest,
        id: "sforum.other",
      }),
      "backend/plugin": elfHeader(),
    });

    await withZip(zip, async (path) => {
      const result = await readExtensionZip(path);
      expect(result.manifest.id).toBe("sforum.markdown-plus");
    });
  });

  test("rejects a missing backend entry", async () => {
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(pluginManifest),
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "backend_entry_missing",
      });
    });
  });

  test("rejects duplicate normalized entry names", async () => {
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(themeManifest),
      "./sforum.extension.json": JSON.stringify(themeManifest),
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "zip_duplicate_entry",
      });
    });
  });

  test("rejects symlink entries", async () => {
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(themeManifest),
      "theme.css": { data: Buffer.from("body{}"), mode: 0o120777 },
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "zip_symlink_entry",
      });
    });
  });

  test("rejects entry names the host refuses to unpack", async () => {
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(themeManifest),
      "docs/version..md": "x",
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "zip_unsafe_path",
      });
    });
  });

  test("verifies declared packageFiles digests", async () => {
    const backend = elfHeader();
    const manifest = {
      ...pluginManifest,
      packageFiles: [
        {
          id: "sforum.markdown-plus.file.backend",
          kind: "executable",
          path: "backend/plugin",
          digest: sha256(backend),
        },
      ],
    };
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(manifest),
      "backend/plugin": backend,
    });

    await withZip(zip, async (path) => {
      const result = await readExtensionZip(path);
      expect(result.manifest.packageFiles).toEqual([
        { path: "backend/plugin", digest: sha256(backend) },
      ]);
    });
  });

  test("rejects a packageFiles digest mismatch", async () => {
    const manifest = {
      ...pluginManifest,
      packageFiles: [
        {
          id: "sforum.markdown-plus.file.backend",
          kind: "executable",
          path: "backend/plugin",
          digest: "a".repeat(64),
        },
      ],
    };
    const zip = await makeZip({
      "sforum.extension.json": JSON.stringify(manifest),
      "backend/plugin": elfHeader(),
    });

    await withZip(zip, async (path) => {
      await expect(readExtensionZip(path)).rejects.toMatchObject({
        code: "package_file_digest_mismatch",
      });
    });
  });
});

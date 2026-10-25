import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Content-addressed local image store.
 *
 * The digest is the identity: `sha256[0:2]/sha256[2:4]/sha256`. Writes are atomic
 * (temp file in the target directory + `rename`), so a crashed request never leaves a
 * half-written image under a key a later read would trust. Reads never throw for
 * caller-supplied keys - an invalid or missing key is simply `null`.
 *
 * The interface is deliberately three methods (`put`/`read`/`exists`) so an object
 * store adapter can replace it without touching the product service.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[0-9A-Za-z._-]{1,128}$/;
const MAX_KEY_LENGTH = 512;

export type StoredAsset = {
  sha256: string;
  storageKey: string;
  created: boolean;
};

/**
 * Split a storage key into safe path segments, or `null` when anything about it is
 * suspicious. The final segment must be a sha256 digest, which keeps keys on the
 * content-addressed layout and makes traversal shapes (`..`, absolute paths,
 * backslashes, NUL bytes) unreachable.
 */
function safeSegments(storageKey: string): string[] | null {
  if (!storageKey || storageKey.length > MAX_KEY_LENGTH) return null;
  if (storageKey.includes("\\") || storageKey.includes("\0")) return null;
  if (storageKey.startsWith("/")) return null;

  const segments = storageKey.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
    if (!SAFE_SEGMENT.test(segment)) return null;
  }

  const digest = segments[segments.length - 1];
  if (!SHA256_PATTERN.test(digest)) return null;
  return segments;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export class LocalAssetStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** `sha256[0:2]/sha256[2:4]/sha256` - the only layout this store reads or writes. */
  static key(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("LocalAssetStore.key expects 64 lowercase hex characters");
    }
    return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  async put(bytes: Uint8Array): Promise<StoredAsset> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = LocalAssetStore.key(sha256);
    const target = this.pathFor(storageKey);
    if (!target) throw new Error("computed storage key is not addressable");

    // Idempotent: identical bytes are already there, so nothing is rewritten.
    if (await this.exists(storageKey)) {
      return { sha256, storageKey, created: false };
    }

    const directory = dirname(target);
    await mkdir(directory, { recursive: true });
    const temp = `${directory}${sep}.tmp-${sha256.slice(0, 16)}-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }

    return { sha256, storageKey, created: true };
  }

  async read(storageKey: string): Promise<Buffer | null> {
    const target = this.pathFor(storageKey);
    if (!target) return null;
    try {
      return await readFile(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    const target = this.pathFor(storageKey);
    if (!target) return false;
    try {
      await stat(target);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /** Absolute path for a key, or `null` when the key is invalid or escapes the root. */
  private pathFor(storageKey: string): string | null {
    const segments = safeSegments(storageKey);
    if (!segments) return null;
    const target = resolve(this.rootDir, ...segments);
    const prefix = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    return target.startsWith(prefix) ? target : null;
  }
}

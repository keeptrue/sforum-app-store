import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { GithubError, type GithubAppClient, type GithubReleaseAsset } from "./client";

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/**
 * A release-asset fetch that failed, classified by whether another attempt could succeed.
 *
 * Callers must branch on `retryable` and never on the message. The two outcomes are not
 * symmetric: `syncRelease` turns a retryable failure into a job retry, while a non-retryable
 * one becomes an `asset_failed` issue that holds every version in the tag — and
 * `needs_attention` is terminal, so those version numbers are gone for good. Misreading the
 * class costs a developer a release; the type is the contract.
 */
export class AssetFetchError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number | null },
  ) {
    super(message);
    this.name = "AssetFetchError";
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

/**
 * Which HTTP answers are worth another attempt.
 *
 * 5xx and 429 are GitHub asking for a retry, 408 is a proxy giving up on a slow body. 401 is
 * in on purpose: an installation token rejected mid-flight is almost always clock skew or a
 * token cached across a rotation, and both fix themselves on the next attempt. Everything
 * else is a verdict — a 404 asset is gone, a 403 means the App lost the repository — and the
 * next attempt would read the same answer.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

/** The one question `syncRelease` asks about a failed fetch. */
export function isRetryableAssetError(error: unknown): boolean {
  return error instanceof AssetFetchError && error.retryable;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything that escapes this module is an `AssetFetchError`.
 *
 * `downloadAsset` raises `GithubError` for the statuses it rejects itself, the HTTP stack
 * raises `TypeError`/`AbortError` for a dead socket or the 90 s timeout, and the local write
 * raises filesystem errors. Anything we cannot name is treated as retryable: a failed retry
 * costs one job attempt, while a wrong "permanent" verdict costs a version number.
 */
function classify(error: unknown): AssetFetchError {
  if (error instanceof AssetFetchError) return error;
  if (error instanceof GithubError) {
    return new AssetFetchError(error.message, {
      retryable: isRetryableStatus(error.status),
      status: error.status,
    });
  }
  return new AssetFetchError(`asset download failed: ${describe(error)}`, {
    retryable: true,
  });
}

export type DownloadedAsset = {
  path: string;
  sha256: string;
  size: number;
  cleanup: () => Promise<void>;
};

/**
 * Stream `body` into `path`, hashing and counting on the way.
 *
 * `pipeline` owns the error wiring, and it has to. `createWriteStream` opens the file
 * asynchronously, so a failed open arrives as an `error` event on a later tick — and a bare
 * `out.write(chunk)` answers `true` for anything under the high-water mark, so the loop would
 * never await, nothing would be listening for that event, and Node would raise it as an
 * uncaught exception and take the process down. `pipeline` attaches its listeners before the
 * first byte and destroys every stream on the way out.
 *
 * Errors are classified here so that this module's rule — everything that escapes is an
 * `AssetFetchError` — holds for the helper too, not just for `downloadReleaseAsset`.
 */
export async function writeAssetBody(
  body: ReadableStream<Uint8Array>,
  path: string,
  expectedSize: number,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_ASSET_BYTES) {
        // A policy ceiling, not a transport problem: the next attempt downloads the same
        // oversized file.
        callback(new AssetFetchError("asset exceeds 50 MiB", { retryable: false }));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(path),
    );
  } catch (error) {
    throw classify(error);
  }

  if (expectedSize > 0 && size !== expectedSize) {
    // A short body is a truncated transfer, which is exactly what a retry fixes.
    throw new AssetFetchError(
      `asset size mismatch: expected ${expectedSize}, got ${size}`,
      { retryable: true },
    );
  }

  return { sha256: hash.digest("hex"), size };
}

export async function downloadReleaseAsset(
  client: Pick<GithubAppClient, "downloadAsset">,
  repoFullName: string,
  installationId: number,
  asset: GithubReleaseAsset,
): Promise<DownloadedAsset> {
  let response: Response;
  try {
    response = await client.downloadAsset(
      repoFullName,
      asset.id,
      installationId,
    );
  } catch (error) {
    throw classify(error);
  }

  if (!response.ok) {
    throw new AssetFetchError(`asset download failed: ${response.status}`, {
      retryable: isRetryableStatus(response.status),
      status: response.status,
    });
  }
  if (!response.body) {
    // An OK status with no body is a broken transport answer, not a verdict about the file.
    throw new AssetFetchError("asset download failed: empty body", {
      retryable: true,
      status: response.status,
    });
  }

  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "sforum-asset-"));
  } catch (error) {
    throw classify(error);
  }

  const path = join(dir, "asset.zip");
  try {
    const written = await writeAssetBody(response.body, path, asset.size);
    return {
      path,
      sha256: written.sha256,
      size: written.size,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    // The temp directory is ours to remove whether the write half-succeeded or never opened.
    await rm(dir, { recursive: true, force: true });
    throw classify(error);
  }
}

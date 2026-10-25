import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import type { GithubAppClient, GithubReleaseAsset } from "./client";

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export type DownloadedAsset = {
  path: string;
  sha256: string;
  size: number;
  cleanup: () => Promise<void>;
};

export async function downloadReleaseAsset(
  client: Pick<GithubAppClient, "downloadAsset">,
  repoFullName: string,
  installationId: number,
  asset: GithubReleaseAsset,
): Promise<DownloadedAsset> {
  const response = await client.downloadAsset(
    repoFullName,
    asset.id,
    installationId,
  );
  if (!response.ok || !response.body) {
    throw new Error(`asset download failed: ${response.status}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "sforum-asset-"));
  const path = join(dir, "asset.zip");
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(path);

  try {
    const stream = Readable.fromWeb(
      response.body as WebReadableStream<Uint8Array>,
    );
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_ASSET_BYTES) {
        throw new Error("asset exceeds 50 MiB");
      }
      hash.update(buffer);
      if (!out.write(buffer)) await once(out, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    if (asset.size > 0 && size !== asset.size) {
      throw new Error(
        `asset size mismatch: expected ${asset.size}, got ${size}`,
      );
    }

    return {
      path,
      sha256: hash.digest("hex"),
      size,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    out.destroy();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

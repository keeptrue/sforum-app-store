import { getDb } from "@/db/client";
import { jsonError } from "@/lib/auth/http";
import { getConfig } from "@/lib/config";
import { findImageAsset, productErrorResponse } from "@/lib/products/service";
import { LocalAssetStore } from "@/lib/storage/local";
import { isAssetSha256 } from "@/lib/storage/urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `BodyInit` takes an ArrayBuffer; avoid copying when the Buffer spans its whole slab. */
function toBody(bytes: Buffer): ArrayBuffer {
  const buffer = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Content-addressed image delivery. The sha256 is the identity, so the response is
 * immutable: a changed image is a different URL. Only images ever live in `assets`.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ sha256: string }> },
) {
  try {
    const { sha256 } = await context.params;
    if (!isAssetSha256(sha256)) return jsonError("asset_not_found", 404);

    const asset = await findImageAsset(getDb(), sha256);
    if (!asset) return jsonError("asset_not_found", 404);

    const store = new LocalAssetStore(getConfig().assetDir);
    const bytes = await store.read(asset.storageKey);
    if (!bytes) return jsonError("asset_not_found", 404);

    return new Response(toBody(bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.mime,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return productErrorResponse(error);
  }
}

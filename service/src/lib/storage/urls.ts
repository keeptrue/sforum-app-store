/**
 * Content-addressed image URLs. The sha256 is the storage key, so the URL is immutable
 * and can carry a one-year cache. `GET /api/assets/{sha256}` serves the bytes.
 */
export function assetUrl(sha256: string): string {
  return `/api/assets/${sha256}`;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isAssetSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

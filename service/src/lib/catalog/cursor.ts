/**
 * Opaque keyset cursor over `(updated_at desc, id desc)`.
 *
 * The token is base64url(JSON{u,i}) with no padding and no signature: it only carries a
 * boundary, so a tampered cursor can at worst start the page somewhere else. Anything
 * that does not decode to `{u: ISO instant, i: non-empty id}` is rejected as invalid and
 * surfaces as `400 invalid_cursor`.
 */
export type CatalogCursor = {
  updatedAt: Date;
  id: string;
};

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function encodeCursor(input: CatalogCursor): string {
  const payload = JSON.stringify({ u: input.updatedAt.toISOString(), i: input.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): CatalogCursor | null {
  if (!BASE64URL.test(raw)) return null;

  let payload: string;
  try {
    payload = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const updatedAt = record.u;
  const id = record.i;
  if (typeof updatedAt !== "string" || !ISO_INSTANT.test(updatedAt)) return null;
  if (typeof id !== "string" || id.length === 0) return null;

  const time = Date.parse(updatedAt);
  if (Number.isNaN(time)) return null;

  return { updatedAt: new Date(time), id };
}

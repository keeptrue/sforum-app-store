/**
 * `extensionIds` is a batch filter: the store plugin asks "which of these installed
 * extensions have an update?" and the catalog answers with only those products.
 *
 * The parser lives outside `query.ts` because that file is already past the 1000-line soft
 * limit, and this is a self-contained contract: comma separated, de-duplicated, sorted, and
 * every id has to match the same grammar the manifest validator uses.
 */

export const MAX_EXTENSION_IDS = 200;

/** Manifest extension ids: lowercase, starts alphanumeric, dots/dashes/underscores inside. */
export const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/;

export type ExtensionIdsResult =
  | { ok: true; ids: string[] | null }
  | { ok: false };

/**
 * `null` means "no filter" — the same meaning as an absent parameter everywhere else in
 * `parseCatalogQuery`, so a blank `?extensionIds=` cannot silently become an empty result.
 *
 * The 200 cap counts *distinct* ids: `a,a,a` is one id, and repeating a value must not turn
 * a legal request into a 400. Invalid ids are rejected rather than dropped, because a caller
 * that cannot spell an extension id is more likely broken than intentionally selective.
 */
export function parseExtensionIds(raw: string | null): ExtensionIdsResult {
  if (raw === null) return { ok: true, ids: null };

  const ids = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    // Holes from `a,,b` and a fully blank value are the blank-value rule of the query
    // parser: ignore the entry, and let the empty set fall through to "no filter".
    if (id.length === 0) continue;
    if (!EXTENSION_ID_PATTERN.test(id)) return { ok: false };
    ids.add(id);
    if (ids.size > MAX_EXTENSION_IDS) return { ok: false };
  }

  if (ids.size === 0) return { ok: true, ids: null };
  // Sorted so two requests naming the same set share one ETag regardless of order.
  return { ok: true, ids: [...ids].sort() };
}

import { createHash } from "node:crypto";

import { renderReleaseNotes } from "./render";

/**
 * Release-notes HTML for the product detail response.
 *
 * Why a memo instead of a column: `notes` is the GitHub release body, and rendering it is a
 * pure function of (source, repoFullName). `loadProductDetail` walks every release on every
 * request, so an already-seen body would otherwise be re-parsed and re-sanitised each time.
 * A content-addressed memo needs no invalidation — change the body and the key changes —
 * and it cannot go stale the way a persisted `notes_html` column can when the renderer or
 * the allow-list changes.
 *
 * Why bounded: a long-lived process serves an unbounded number of products, and release
 * bodies are attacker-influenced text (any developer can publish one). The map is a plain
 * insertion-ordered LRU: reading a key moves it to the end, and the oldest entry is dropped
 * once the limit is exceeded, so memory is proportional to the cap rather than to the
 * catalog.
 */
const MEMO_LIMIT = 200;

const memo = new Map<string, string>();

function memoKey(source: string, repoFullName: string | null): string {
  // The repository name participates because relative references resolve against it; the
  // NUL separator keeps a `null` repo from colliding with a repository literally named "".
  return createHash("sha256")
    .update(repoFullName ?? "\u0000")
    .update("\u0000")
    .update(source)
    .digest("hex");
}

/**
 * Rendered, sanitised notes HTML for one release body, or `null` when there are no notes.
 * The HTML is safe for `dangerouslySetInnerHTML` and for the plugin's admin page for the
 * same reason the README's is: it is produced by `renderReleaseNotes`, whose only output
 * path is the sanitise allow-list.
 */
export function releaseNotesHtml(
  source: string | null,
  repoFullName: string | null,
): string | null {
  if (source === null || source.trim().length === 0) return null;

  const key = memoKey(source, repoFullName);
  const cached = memo.get(key);
  if (cached !== undefined) {
    // Refresh recency: delete + set is what makes the Map an LRU without a second structure.
    memo.delete(key);
    memo.set(key, cached);
    return cached;
  }

  const html = renderReleaseNotes({ source, repoFullName });
  memo.set(key, html);
  if (memo.size > MEMO_LIMIT) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  return html;
}

/** Test seam: the memo is process-wide state, so suites reset it between cases. */
export function resetReleaseNotesMemo(): void {
  memo.clear();
}

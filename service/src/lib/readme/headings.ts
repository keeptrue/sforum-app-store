/**
 * Heading list for a rendered README, derived from the HTML the store itself produced.
 *
 * The table of contents needs `{id, label, level}` and nothing else, and the document already
 * carries all three: `lib/readme/render.ts` gives every heading a stable `id` and a permalink
 * anchor. Deriving the list here — instead of scraping the DOM after hydration — keeps the
 * contents in the server-rendered markup (no layout shift, and it works with JavaScript off),
 * and it keeps the database row a plain document with no side-channel column to migrate.
 *
 * The input is our own output, not arbitrary repository HTML, so a regex is the honest tool:
 * the shapes it has to match are the ones `markdown-it-anchor` emits. Anything unexpected
 * simply yields fewer entries, which is a cosmetic loss, never a correctness one.
 */

export type ReadmeHeading = { id: string; label: string; level: number };

const HEADING = /<h([2-6])\s[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
const PERMALINK = /<a[^>]*class="header-anchor"[^>]*>[\s\S]*?<\/a>/g;
const TAG = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (match) => ENTITIES[match] ?? match);
}

export function extractHeadings(html: string): ReadmeHeading[] {
  const headings: ReadmeHeading[] = [];
  for (const match of html.matchAll(HEADING)) {
    const [, level, id, inner] = match;
    if (!level || !id || inner === undefined) continue;
    const label = decodeEntities(inner.replace(PERMALINK, "").replace(TAG, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (label.length === 0) continue;
    headings.push({ id: decodeEntities(id), label, level: Number.parseInt(level, 10) });
  }
  return headings;
}

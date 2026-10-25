/**
 * "Fill the summary from the README" — the only copy the store still asks a developer to
 * write. The extraction is deliberately conservative: a summary is a human sentence that
 * happens to be seeded from the first real paragraph, not a machine digest of the document.
 *
 * Everything that is navigation rather than prose is skipped (headings, badges, rules,
 * comments, screenshots), and the result is cut at a sentence boundary when one is close
 * enough to the limit.
 */

const DEFAULT_MAX_LENGTH = 300;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_MARKER = /^\[[ xX]\]\s+/;
const QUOTE_MARKER = /^\s{0,3}>\s?/;

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const INLINE_IMAGE_REF = /!\[[^\]]*\]\[[^\]]*\]/g;
// Empty labels are allowed on purpose: `[![badge](img)](link)` leaves `[](link)` after the
// image is removed, and that must count as decoration rather than as prose.
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const LINK_REF = /\[([^\]]*)\]\[[^\]]*\]/g;
const INLINE_CODE = /`([^`]+)`/g;
const BOLD = /\*\*([^*]+)\*\*/g;
const BOLD_UNDERSCORE = /__([^_]+)__/g;
const STRIKE = /~~([^~]+)~~/g;
const ITALIC_STAR = /\*([^*\n]+)\*/g;
const ITALIC_UNDERSCORE = /(^|[\s(（])_([^_\n]+)_(?=[\s)）。，,]|$)/g;
const HTML_TAG = /<[^>]+>/g;

/** Only the entities a README first paragraph realistically contains. */
const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

function decodeEntities(value: string): string {
  let next = value;
  for (const [pattern, replacement] of ENTITIES) next = next.replace(pattern, replacement);
  return next;
}

function stripInline(value: string): string {
  return value
    .replace(IMAGE, "")
    .replace(INLINE_IMAGE_REF, "")
    .replace(LINK, "$1")
    .replace(LINK_REF, "$1")
    .replace(INLINE_CODE, "$1")
    .replace(BOLD, "$1")
    .replace(BOLD_UNDERSCORE, "$1")
    .replace(STRIKE, "$1")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDERSCORE, "$1$2")
    .replace(HTML_TAG, "");
}

/** A line whose only content is a badge or a screenshot carries no prose. */
function isDecorationOnly(line: string): boolean {
  const stripped = line.replace(IMAGE, "").replace(INLINE_IMAGE_REF, "").replace(LINK, "").replace(LINK_REF, "");
  return stripped.trim().length === 0;
}

function firstParagraph(markdown: string): string {
  const body = markdown.replace(FRONTMATTER, "").replace(HTML_COMMENT, "");
  const lines = body.split(/\r?\n/);

  const collected: string[] = [];
  let insideFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      // A code block before the first paragraph is not prose; skip the whole block.
      if (collected.length > 0) break;
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    if (line.trim().length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    if (HEADING.test(line) || RULE.test(line)) {
      if (collected.length > 0) break;
      continue;
    }
    if (isDecorationOnly(line)) {
      if (collected.length > 0) break;
      continue;
    }

    collected.push(
      line
        .replace(QUOTE_MARKER, "")
        .replace(LIST_MARKER, "")
        .replace(TASK_MARKER, "")
        .trim(),
    );
  }

  return collected.join(" ");
}

function cutAtSentence(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const window = value.slice(0, maxLength);
  // Prefer the last sentence end inside the window, but only when it keeps most of it;
  // otherwise a two-character first sentence would become the whole summary.
  const boundary = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf("."),
    window.lastIndexOf("!"),
    window.lastIndexOf("?"),
  );
  if (boundary >= Math.floor(maxLength * 0.6)) {
    return window.slice(0, boundary + 1).trim();
  }
  return `${window.trimEnd()}…`;
}

/**
 * Derive a summary candidate from a README. Returns an empty string when the document has no
 * prose before its first heading or code block — the caller keeps the field empty rather than
 * inventing copy.
 */
export function extractSummary(
  markdown: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  const paragraph = stripInline(firstParagraph(markdown))
    .replace(/\s+/g, " ")
    .trim();
  if (paragraph.length === 0) return "";

  return cutAtSentence(decodeEntities(paragraph), maxLength);
}

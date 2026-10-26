import MarkdownIt from "markdown-it";
// The package exports the instance type separately from the callable default; annotating with
// the default value is what `tsc` rejects.
import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import sanitizeHtml from "sanitize-html";

/**
 * README rendering for the public product page.
 *
 * The store never serves GitHub's HTML. A repository's markdown is rendered here and then
 * passed through a strict allow-list, so a repository can influence text and a small set of
 * attributes and nothing else. Every URL decision lives in the `sanitize-html` transform
 * below rather than in the markdown renderer, because raw HTML inside a README
 * (`<img src="./shot.png">`) must obey exactly the same rules as a markdown image.
 *
 * Two rewrite rules matter:
 *
 * 1. Relative media becomes `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`. The
 *    store does not proxy README media: no storage, and no outbound fetch on a render path
 *    that a visitor can trigger. The consequence (the visitor's browser talks to GitHub
 *    directly) is a recorded decision, not an oversight.
 * 2. `http:` images are demoted to plain links. A browser would block the mixed content
 *    anyway; demoting keeps the description instead of leaving a hole.
 *
 * Three structural additions exist so the document can be *read*, not just displayed:
 *
 * - Headings carry a stable `id` plus a `#` permalink (`markdown-it-anchor`), which is what
 *   lets the page build a table of contents and deep-link a section.
 * - Fenced code is highlighted into `hljs-*` classes. Class output, not inline styles: the
 *   allow-list below refuses `style`, and it must keep refusing it, because arbitrary inline
 *   CSS from a repository is a page-wide overlay/phishing primitive. Highlighting is done
 *   here, on the server, so no highlighter ships to the browser.
 * - Tables and code blocks are wrapped in a container element. `display: block` on `<table>`
 *   (the previous scroll trick) makes `thead` and `tbody` resolve their columns independently,
 *   so columns drift; a wrapper scrolls instead and lets the table keep its own layout.
 */

/** `rel` on every outbound link: no referrer, no opener, and not a vouched-for source. */
const EXTERNAL_REL = "nofollow noopener noreferrer ugc";

const RAW_HOST = "raw.githubusercontent.com";
const RAW_BASE = `https://${RAW_HOST}`;
const GITHUB_BASE = "https://github.com";

/**
 * `raw.invalid` is a placeholder host used only to let `URL` normalise a repository path.
 * Nothing is ever requested from it; the result is re-prefixed with `RAW_BASE`.
 */
const PATH_BASE = "https://raw.invalid/";

/** A heading id is used in `href="#…"`, so it is limited to what a URL fragment can carry. */
const HEADING_ID = /^[\p{Letter}\p{Number}_-]+$/u;

const HEADING_TAGS = ["h2", "h3", "h4", "h5", "h6"] as const;

const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "span",
  "strong",
  "em",
  "del",
  "s",
  "details",
  "summary",
  "sup",
  "sub",
  "input",
  // Only for the `readme-table` / `readme-code` wrappers this module emits. A README that
  // writes its own `<div>` keeps it with every attribute stripped, which renders as nothing.
  "div",
] as const;

/** The languages a README in this ecosystem actually uses; anything else stays plain text. */
const HIGHLIGHT_LANGUAGES = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  ini,
  javascript,
  json,
  python,
  sql,
  typescript,
  xml,
  yaml,
} as const;

/**
 * Fence info strings are written by humans. Map the common aliases onto a registered
 * grammar instead of letting each one fall through to "no highlighting".
 */
const LANGUAGE_ALIASES: Record<string, keyof typeof HIGHLIGHT_LANGUAGES> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  css: "css",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  go: "go",
  golang: "go",
  ini: "ini",
  toml: "ini",
  conf: "ini",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  python: "python",
  py: "python",
  sql: "sql",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  html: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
};

for (const [name, grammar] of Object.entries(HIGHLIGHT_LANGUAGES)) {
  hljs.registerLanguage(name, grammar);
}

export type ReadmeSourceFormat = "markdown" | "text";

export type ReadmeRenderInput = {
  source: string;
  /** `owner/repo`. The caller has already checked the shape against GitHub's rules. */
  repoFullName: string;
  /** Repository-relative README path, e.g. `README.md` or `docs/README.md`. */
  path: string;
  format: ReadmeSourceFormat;
};

/**
 * `repoFullName` may be empty: release notes can be rendered for a product whose repository
 * binding is gone. A relative reference then has no repository to resolve against, so it is
 * dropped instead of being pointed at `raw.githubusercontent.com//…`.
 */
type RenderEnv = { repoFullName: string; path: string };

/**
 * Parser options shared by both documents. Raw HTML is allowed through the parser and
 * removed by the allow-list below; without this, `<details>` and `<picture>` would render as
 * literal text.
 */
const MARKDOWN_OPTIONS = {
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
} as const;

function createMarkdown(): MarkdownItInstance {
  return new MarkdownIt(MARKDOWN_OPTIONS);
}

// GFM task lists render as read-only checkboxes. `enabled: false` is the whole point: a
// visitor must not be able to tick a box that only exists in a README, and `label: false`
// keeps the plugin from emitting a `<label>` (which the allow-list would drop anyway).
function useTaskLists(md: MarkdownItInstance): MarkdownItInstance {
  return md.use(taskLists, { enabled: false, label: false });
}

const markdown = useTaskLists(createMarkdown());

/**
 * Heading ids stay readable for CJK. The plugin's default slugifier percent-encodes
 * everything outside ASCII, which turns `## 安装` into `#%E5%AE%89%E8%A3%85`; keeping the
 * characters makes the anchor match what a reader sees, and still yields a valid fragment.
 */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{Letter}\p{Number}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

markdown.use(anchor, {
  slugify,
  // `ariaHidden` is the GitHub shape: `<h2 id="x"><a class="header-anchor" href="#x"
  // aria-hidden="true">#</a> Title</h2>`. The permalink is decorative, so it stays out of the
  // accessibility tree and out of the heading's spoken text.
  permalink: anchor.permalink.ariaHidden({ placement: "before", symbol: "#" }),
});

/**
 * README headings sit inside a page that already owns the h1, so an author's `#` is clamped
 * to `h2`. Everything below is left alone: shifting the whole document by one level pushed
 * the most common section level (`###`) down to `h4`, where it rendered at body size and
 * stopped reading as a section at all.
 */
function readmeHeadingTag(tag: string): string {
  return tag === "h1" ? "h2" : tag;
}

/**
 * Release notes render under a per-release `h3` inside the admin dialog (`h2` is the product
 * name), so their headings start one level lower than a README's. `#` and `##` collapse to
 * `h4` for the same reason a README collapses `#` into `h2`: GitHub release bodies use `##`
 * as the ordinary section level, and demoting everything by exactly two would push `###`
 * down to body size.
 */
function notesHeadingTag(tag: string): string {
  switch (tag) {
    case "h1":
    case "h2":
      return "h4";
    case "h3":
      return "h5";
    default:
      return "h6";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/** Resolve a fence info string to a registered grammar, or `null` when it is unknown. */
function highlightLanguage(info: string): keyof typeof HIGHLIGHT_LANGUAGES | null {
  const declared = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (declared.length === 0) return null;
  return LANGUAGE_ALIASES[declared] ?? null;
}

/**
 * Fenced code becomes a container + `pre`, not a bare `pre`, because the language chip and
 * the copy button have to sit still while the code scrolls horizontally. Highlighting is
 * class-based so the allow-list can keep refusing `style`.
 */
function installRules(
  md: MarkdownItInstance,
  mapHeading: (tag: string) => string,
  rulerName: string,
): MarkdownItInstance {
  md.core.ruler.push(rulerName, (state) => {
    for (const token of state.tokens) {
      if (token.type !== "heading_open" && token.type !== "heading_close") continue;
      const next = mapHeading(token.tag);
      if (next !== token.tag) token.tag = next;
    }
  });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!;
    const language = highlightLanguage(token.info);
    const body =
      language === null
        ? escapeHtml(token.content)
        : hljs.highlight(token.content, { language, ignoreIllegals: true }).value;
    const lang = language === null ? "" : ` data-lang="${escapeAttr(language)}"`;
    const codeClass = language === null ? "" : ` class="hljs language-${escapeAttr(language)}"`;
    return `<div class="readme-code"${lang}><pre><code${codeClass}>${body}</code></pre></div>`;
  };

  // Wrap every table in a scroll container. `role="region"` + `tabindex="0"` is what makes
  // the container reachable and scrollable from the keyboard, which a plain
  // `overflow-x: auto` box is not.
  md.renderer.rules.table_open = () => `${TABLE_OPEN}<table>\n`;
  md.renderer.rules.table_close = () => "</table>\n</div>\n";

  return md;
}

const TABLE_OPEN =
  '<div class="readme-table" role="region" tabindex="0" aria-label="表格，可横向滚动">';

installRules(markdown, readmeHeadingTag, "sforum_heading_level");

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//");
}

function parseAbsolute(value: string): URL | null {
  const withScheme = value.startsWith("//") ? `https:${value}` : value;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Resolve a repository-relative reference against the README's own directory.
 *
 * `URL` already collapses `..`, so a traversal cannot escape the repository root; the extra
 * decoded-segment check catches the encoded form (`%2e%2e`) that survives normalisation.
 * The returned path keeps its percent-encoding so `raw.githubusercontent.com` receives the
 * same bytes the README author wrote.
 */
function resolveRepoPath(readmePath: string, reference: string): string | null {
  const slash = readmePath.lastIndexOf("/");
  const directory = slash === -1 ? "" : readmePath.slice(0, slash + 1);

  let resolved: URL;
  try {
    resolved = new URL(reference, `${PATH_BASE}${directory}`);
  } catch {
    return null;
  }
  if (resolved.host !== "raw.invalid") return null;

  const path = resolved.pathname.replace(/^\/+/, "");
  if (path.length === 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

type ImageResolution =
  | { kind: "image"; url: string }
  | { kind: "link"; url: string }
  | null;

function resolveImage(source: string, env: RenderEnv): ImageResolution {
  const value = source.trim();
  if (value.length === 0 || value.startsWith("#")) return null;

  if (isAbsoluteUrl(value)) {
    const url = parseAbsolute(value);
    if (!url) return null;
    if (url.protocol === "https:") return { kind: "image", url: url.toString() };
    // `http:` is a mixed-content block and every other scheme (data:, blob:, file:) is
    // either an injection vector or unreachable from a browser page.
    return url.protocol === "http:"
      ? { kind: "link", url: url.toString() }
      : null;
  }

  // A relative reference is only meaningful against a bound repository. Release notes can be
  // rendered for a product whose binding is gone, and a URL built from an empty repo name
  // (`raw.githubusercontent.com//HEAD/…`) would be a broken image, not a document.
  if (env.repoFullName.length === 0) return null;
  const path = resolveRepoPath(env.path, value);
  if (path === null) return null;
  return { kind: "image", url: `${RAW_BASE}/${env.repoFullName}/HEAD/${path}` };
}

type LinkResolution = { href: string; external: boolean } | null;

function resolveLink(href: string, env: RenderEnv): LinkResolution {
  const value = href.trim();
  if (value.length === 0) return null;
  // In-page anchors stay in the page; opening them in a new tab would be nonsense.
  if (value.startsWith("#")) return { href: value, external: false };

  if (isAbsoluteUrl(value)) {
    const url = parseAbsolute(value);
    if (!url) return null;
    if (url.protocol === "mailto:") {
      return { href: url.toString(), external: false };
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { href: url.toString(), external: true };
    }
    return null;
  }

  if (env.repoFullName.length === 0) return null;
  const path = resolveRepoPath(env.path, value);
  if (path === null) return null;
  return { href: `${GITHUB_BASE}/${env.repoFullName}/blob/HEAD/${path}`, external: true };
}

/**
 * A heading may only carry the `id` this module generated (or one a repository wrote that
 * happens to be fragment-safe) plus the `tabindex="-1"` the anchor plugin adds. Anything
 * else — `id="main"`, an event handler — is dropped, because a heading id is a link target
 * for the whole page.
 */
function headingAttributes(attribs: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  const id = attribs.id;
  if (id && HEADING_ID.test(id)) next.id = id;
  if (attribs.tabindex === "-1") next.tabindex = "-1";
  return next;
}

function sanitizeOptions(env: RenderEnv): sanitizeHtml.IOptions {
  const headingTransforms = Object.fromEntries(
    HEADING_TAGS.map((tag) => [tag, (_tagName: string, attribs: Record<string, string>) => ({
      tagName: tag,
      attribs: headingAttributes(attribs),
    })]),
  ) as sanitizeHtml.IOptions["transformTags"];

  return {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: {
      a: ["href", "rel", "target", "title", "aria-hidden"],
      img: ["src", "alt", "title", "width", "height", "loading", "referrerpolicy"],
      th: ["align"],
      td: ["align"],
      p: ["align"],
      // `id` and `tabindex` are filtered again by `headingAttributes`; listing them here is
      // what lets the transform's output survive the allow-list pass that follows it.
      h2: ["id", "tabindex"],
      h3: ["id", "tabindex"],
      h4: ["id", "tabindex"],
      h5: ["id", "tabindex"],
      h6: ["id", "tabindex"],
      // Emitted by the table/code wrapper rules above; a README's own `div` keeps no
      // attributes beyond these, and its `class` must still match `allowedClasses`.
      div: ["role", "tabindex", "aria-label", "data-lang"],
      // Only the checkbox shape `markdown-it-task-lists` emits: no name, no value, no form.
      input: ["type", "checked", "disabled"],
    },
    // `class` is not listed as a free attribute anywhere: `allowedClasses` is the only way a
    // class survives, and each entry is an exact name or a prefix.
    allowedClasses: {
      div: ["readme-table", "readme-code"],
      code: ["hljs", "language-*"],
      span: ["hljs-*"],
      a: ["header-anchor"],
    },
    // Images are restricted to `https:` by tag; links may also use `mailto:`.
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      ...headingTransforms,
      // The only `input` a README may produce is a read-only checkbox. Anything else (a text
      // field inside a form, a submit button) is replaced by nothing rather than sanitised
      // into a harmless-looking control that lies about being interactive.
      input: (_tagName, attribs): sanitizeHtml.Tag => {
        if (attribs.type !== "checkbox") return { tagName: "span", attribs: {} };
        return {
          tagName: "input",
          attribs: {
            type: "checkbox",
            disabled: "disabled",
            // `checked` arrives as an empty string from the plugin's boolean attribute; the
            // presence of the key is the signal, not its value.
            ...("checked" in attribs ? { checked: "checked" } : {}),
          },
        };
      },
      img: (_tagName, attribs): sanitizeHtml.Tag => {
        const resolution = resolveImage(attribs.src ?? "", env);
        const alt = attribs.alt ?? "";
        if (resolution === null) {
          // Keep the description, drop the request. An invisible hole is worse than text.
          return { tagName: "span", attribs: {}, text: alt };
        }
        if (resolution.kind === "link") {
          return {
            tagName: "a",
            attribs: { href: resolution.url, rel: EXTERNAL_REL, target: "_blank" },
            text: alt.length > 0 ? alt : resolution.url,
          };
        }
        const next: Record<string, string> = {
          src: resolution.url,
          alt,
          loading: "lazy",
          referrerpolicy: "no-referrer",
        };
        if (attribs.title) next.title = attribs.title;
        if (attribs.width) next.width = attribs.width;
        if (attribs.height) next.height = attribs.height;
        return { tagName: "img", attribs: next };
      },
      a: (_tagName, attribs): sanitizeHtml.Tag => {
        const resolution = resolveLink(attribs.href ?? "", env);
        if (resolution === null) {
          // A `javascript:` or `data:` link keeps its text and loses its target.
          return { tagName: "span", attribs: {} };
        }
        const next: Record<string, string> = { href: resolution.href };
        if (attribs.title) next.title = attribs.title;
        // Rebuilt from scratch, so the heading permalink's class has to be carried over by
        // hand; without this the anchor loses its styling and its hover affordance.
        if (attribs.class === "header-anchor") {
          next.class = "header-anchor";
          // Decorative: the heading text already carries the label, so the permalink stays
          // out of the accessibility tree exactly as it is on GitHub.
          next["aria-hidden"] = "true";
        }
        if (resolution.external) {
          next.rel = EXTERNAL_REL;
          next.target = "_blank";
        }
        return { tagName: "a", attribs: next };
      },
    },
  };
}

/**
 * Render a README to sanitised HTML. The result is safe to hand to `dangerouslySetInnerHTML`
 * and to the plugin's admin page, which is why the contract publishes HTML instead of
 * markdown: one renderer, one allow-list, both surfaces.
 */
export function renderReadme(input: ReadmeRenderInput): string {
  const env: RenderEnv = { repoFullName: input.repoFullName, path: input.path };
  const raw =
    input.format === "text"
      ? `<pre>${escapeHtml(input.source)}</pre>`
      : markdown.render(input.source, env);
  return sanitizeHtml(raw, sanitizeOptions(env));
}

/** Exposed for tests: the same allow-list without the markdown layer. */
export function sanitizeReadmeHtml(html: string, env: RenderEnv): string {
  return sanitizeHtml(html, sanitizeOptions(env));
}

/**
 * Release notes are a second markdown document on the same allow-list.
 *
 * Differences from a README, both deliberate:
 *
 * 1. **No `markdown-it-anchor`.** One dialog lists every release, so generated heading ids
 *    would collide across versions and a `#` permalink would deep-link to the wrong entry.
 *    The notes have no table of contents to build, so the ids buy nothing.
 * 2. **Headings start at `h4`.** They render under a per-release `h3` inside a dialog whose
 *    title is `h2`; see `notesHeadingTag`.
 *
 * Relative images and links resolve against the repository root, which is how a release body
 * is written on GitHub. `repoFullName` may be empty (unbound product): relative references
 * are then dropped rather than pointed at a nonexistent repository.
 */
export function renderReleaseNotes(input: {
  source: string;
  repoFullName: string | null;
}): string {
  const env: RenderEnv = { repoFullName: input.repoFullName ?? "", path: "" };
  return sanitizeHtml(notesMarkdown.render(input.source, env), sanitizeOptions(env));
}

const notesMarkdown = installRules(
  useTaskLists(createMarkdown()),
  notesHeadingTag,
  "sforum_notes_heading_level",
);

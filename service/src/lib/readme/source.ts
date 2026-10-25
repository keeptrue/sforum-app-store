/**
 * Where a README came from, expressed in the two forms the store needs:
 * a repository-relative path plus the source format the renderer must use.
 *
 * Kept free of database and HTTP imports so both the dashboard DTO mapper and the GitHub
 * fetch layer can share one definition of "the source URL".
 */

/** Extensions markdown-it renders. Anything else is shown as preformatted text. */
const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mdwn",
  ".mdx",
]);

export type ReadmeSourceFormat = "markdown" | "text";

export function readmeFormatFor(path: string): ReadmeSourceFormat {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : "text";
}

/** `https://github.com/<owner>/<repo>/blob/<ref>/<path>` — never an API or asset address. */
export function readmeSourceUrl(
  repoFullName: string,
  path: string,
  ref = "HEAD",
): string {
  return `https://github.com/${repoFullName}/blob/${ref}/${path}`;
}

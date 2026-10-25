import { describe, expect, test } from "bun:test";

import { renderReadme, sanitizeReadmeHtml } from "./render";

const REPO = "acme/sforum-plugin";
const PATH = "README.md";

function render(markdown: string, path = PATH): string {
  return renderReadme({
    source: markdown,
    repoFullName: REPO,
    path,
    format: "markdown",
  });
}

describe("renderReadme", () => {
  test("renders GFM tables and fenced code", () => {
    const html = render(
      ["| a | b |", "| - | - |", "| 1 | 2 |", "", "```ts", "const x = 1;", "```"].join("\n"),
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<pre><code");
    // Highlighting splits the source into `hljs-*` spans, so the statement is no longer one
    // contiguous string; the keyword span is the assertion that survives that.
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("x = ");
    expect(html).toContain('<span class="hljs-number">1</span>');
  });

  test("clamps a README h1 to h2 so the page keeps one h1", () => {
    const html = render("# Title\n\n## Section\n\n### Detail");
    expect(html).not.toContain("<h1");
    expect(html).toContain('<h2 id="title"');
    // `##` is *not* shifted further: pushing the common section level down one step was what
    // made `###` render at body size.
    expect(html).toContain('<h2 id="section"');
    expect(html).toContain('<h3 id="detail"');
  });

  test("keeps a CJK heading id readable and de-duplicates repeats", () => {
    const html = render("## 安装\n\n### 安装");
    expect(html).toContain('id="安装"');
    expect(html).toContain('id="安装-1"');
  });

  test("keeps the heading permalink class and target through the allow-list", () => {
    const html = render("## 安装");
    expect(html).toContain('class="header-anchor"');
    expect(html).toContain('href="#安装"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
  });

  test("drops a heading id that is not fragment-safe", () => {
    const html = render('<h2 id="a b">raw</h2><h2 id="ok-1">kept</h2>');
    expect(html).not.toContain('id="a b"');
    expect(html).toContain('id="ok-1"');
  });

  test("wraps a table in a keyboard-scrollable region", () => {
    const html = render("| a |\n| - |\n| 1 |");
    expect(html).toContain('<div class="readme-table" role="region" tabindex="0"');
    expect(html).toContain('aria-label="表格，可横向滚动"');
    expect(html).toContain("<table>");
    expect(html.trimEnd().endsWith("</div>")).toBe(true);
  });

  test("labels a highlighted fence and maps an alias to its grammar", () => {
    const html = render("```yml\nkey: 1\n```");
    expect(html).toContain('<div class="readme-code" data-lang="yaml">');
    expect(html).toContain('class="hljs language-yaml"');
  });

  test("leaves an unknown fence language as escaped plain text", () => {
    const html = render("```not-a-language\n<script>alert(1)</script>\n```");
    expect(html).toContain('<div class="readme-code">');
    expect(html).not.toContain("data-lang");
    expect(html).not.toContain("language-not-a-language");
    expect(html).toContain("&lt;script&gt;");
  });

  test("keeps a centred paragraph but not a repository div's class or style", () => {
    const html = render(
      '<p align="center"><img src="https://img.shields.io/badge/a-b.svg" alt="badge"></p>\n\n<div class="evil" style="position:fixed">x</div>',
    );
    expect(html).toContain('<p align="center">');
    expect(html).toContain("<div>x</div>");
    expect(html).not.toContain('class="evil"');
    expect(html).not.toContain("style=");
  });

  test("rewrites a relative image to raw.githubusercontent.com", () => {
    const html = render("![shot](./docs/shot.png)");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/docs/shot.png"',
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="no-referrer"');
  });

  test("resolves a relative image against the README directory", () => {
    const html = render("![shot](shot.png)", "docs/README.md");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/docs/shot.png"',
    );
  });

  test("rewrites a raw HTML image the same way", () => {
    const html = render('<img src="docs/shot.png" alt="raw" width="320">');
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/docs/shot.png"',
    );
    expect(html).toContain('width="320"');
  });

  test("demotes an http image to a link and keeps its alt text", () => {
    const html = render("![legacy](http://example.com/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="http://example.com/a.png"');
    expect(html).toContain("legacy");
    expect(html).toContain('rel="nofollow noopener noreferrer ugc"');
  });

  test("drops data: images but keeps the alt text", () => {
    const html = render("![inline](data:image/png;base64,AAAA)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
    expect(html).toContain("inline");
  });

  test("clamps a traversal to the repository root", () => {
    // `URL` collapses `..`, so the reference lands at the repository root; the raw host is
    // never asked for a local path. An encoded `%2e%2e` survives normalisation and is
    // rejected outright (next test).
    const html = render("![x](../../../../etc/passwd)");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/etc/passwd"',
    );
    expect(html).not.toContain("file:");
  });

  test("normalises an encoded traversal before it reaches the raw host", () => {
    // The URL parser treats `%2e%2e` as a dot segment, so the reference is clamped to the
    // repository root exactly like a literal `..`; no encoded bytes reach the request.
    const html = render("![x](%2e%2e/%2e%2e/secret.png)");
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/secret.png"',
    );
    expect(html).not.toContain("%2e");
  });

  test("does not follow a protocol-relative image host", () => {
    const html = render("![x](//evil.example/x.png)");
    expect(html).toContain('src="https://evil.example/x.png"');
    expect(html).not.toContain("raw.githubusercontent.com");
  });

  test("keeps in-page anchors as anchors and marks outbound links", () => {
    const html = render("[top](#install) and [docs](https://example.com/doc)");
    expect(html).toContain('href="#install"');
    expect(html).toContain('href="https://example.com/doc"');
    expect(html).toContain('target="_blank"');
  });

  test("rewrites a relative link to a GitHub blob URL", () => {
    const html = render("[install](./docs/install.md)");
    expect(html).toContain(
      'href="https://github.com/acme/sforum-plugin/blob/HEAD/docs/install.md"',
    );
  });

  test("strips javascript: links, scripts and event handlers", () => {
    const html = render(
      [
        "[click](javascript:alert(1))",
        "",
        '<a href="javascript:alert(1)">raw</a>',
        "",
        "<script>alert(1)</script>",
        "",
        '<img src="https://example.com/a.png" onerror="alert(1)">',
        "",
        '<a href="https://example.com" onclick="alert(1)">x</a>',
      ].join("\n"),
    );
    // markdown-it refuses the scheme and leaves the source as text; the raw HTML link is
    // reduced to a span by the allow-list. Neither may survive as an href.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).toContain("click");
    expect(html).toContain("raw");
  });

  test("keeps <details> blocks but drops inline styles", () => {
    const html = render(
      '<details><summary>More</summary><p style="color:red">body</p></details>',
    );
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>More</summary>");
    expect(html).not.toContain("style=");
  });

  test("renders GFM task lists as read-only checkboxes", () => {
    const html = render("- [x] tables\n- [ ] math");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).toContain("checked");
    expect(html).not.toContain("[x]");
    expect(html).not.toContain("[ ]");
  });

  test("never lets a README submit a form", () => {
    const html = render('<form action="https://evil.example"><input type="text" name="x"></form>');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });

  test("renders a non-markdown README as preformatted text", () => {
    const html = renderReadme({
      source: "Title\n=====\n\n*not* markdown",
      repoFullName: REPO,
      path: "README.rst",
      format: "text",
    });
    expect(html).toContain("<pre>");
    expect(html).toContain("*not* markdown");
    expect(html).not.toContain("<em>");
  });

  test("escapes HTML inside a plain-text README", () => {
    const html = renderReadme({
      source: "<script>alert(1)</script>",
      repoFullName: REPO,
      path: "README.txt",
      format: "text",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sanitizeReadmeHtml", () => {
  test("keeps an allow-listed image and rewrites its source", () => {
    const html = sanitizeReadmeHtml(
      '<img src="shot.png" alt="a">',
      { repoFullName: REPO, path: "README.md" },
    );
    expect(html).toContain("https://raw.githubusercontent.com/acme/sforum-plugin/HEAD/shot.png");
  });

  test("drops an iframe entirely", () => {
    const html = sanitizeReadmeHtml(
      '<iframe src="https://example.com"></iframe><p>after</p>',
      { repoFullName: REPO, path: "README.md" },
    );
    expect(html).not.toContain("iframe");
    expect(html).toContain("after");
  });
});

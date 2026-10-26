import { beforeEach, describe, expect, test } from "bun:test";

import { releaseNotesHtml, resetReleaseNotesMemo } from "./notes";
import { renderReleaseNotes } from "./render";

const REPO = "acme/sforum-plugin";

function render(source: string, repoFullName: string | null = REPO): string {
  return renderReleaseNotes({ source, repoFullName });
}

beforeEach(() => {
  resetReleaseNotesMemo();
});

describe("renderReleaseNotes", () => {
  test("renders the markdown shapes a release body actually uses", () => {
    const html = render(
      ["## 变更", "", "- 修复登录", "- 新增导出", "", "```ts", "const a = 1;", "```"].join("\n"),
    );
    expect(html).toContain("变更");
    expect(html).toContain("<li>修复登录</li>");
    expect(html).toContain('class="readme-code"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  test("demotes headings under the per-release head instead of starting at h2", () => {
    // The dialog title is `h2` and each release head is `h3`, so a body `##` must not claim
    // the same level as the product name.
    const html = render(["# 标题", "", "## 章节", "", "### 细节", "", "#### 更深"].join("\n"));
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("<h3");
    expect(html).toContain("<h4");
    expect(html).toContain("<h5");
    expect(html).toContain("<h6");
  });

  test("carries no heading ids or permalinks: one dialog lists every release", () => {
    const html = render("## 变更");
    expect(html).not.toContain("id=");
    expect(html).not.toContain("header-anchor");
  });

  test("sanitises exactly like a README", () => {
    const html = render(
      [
        '<script>alert(1)</script>',
        // Raw HTML rather than `[x](javascript:…)`: markdown-it refuses that destination and
        // leaves it as text, which would test the parser instead of the allow-list.
        '<a href="javascript:alert(1)">click</a>',
        '<img src="data:image/png;base64,AAA" alt="inline">',
        '<div style="position:fixed;inset:0">overlay</div>',
        "<iframe src=\"https://evil.example\"></iframe>",
      ].join("\n\n"),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">click<");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("style=");
    // The description survives even when the request does not.
    expect(html).toContain("inline");
    expect(html).toContain("overlay");
  });

  test("resolves a relative image against the repository root", () => {
    const html = render("![shot](./docs/shot.png)");
    expect(html).toContain(`src="https://raw.githubusercontent.com/${REPO}/HEAD/docs/shot.png"`);
  });

  test("drops a relative image when the product has no bound repository", () => {
    const html = render("![shot](./docs/shot.png)", null);
    expect(html).not.toContain("raw.githubusercontent.com");
    // The alt text is what a reader gets instead of a hole.
    expect(html).toContain("shot");
  });

  test("keeps a release link pointed at its GitHub page", () => {
    const html = render("[上游地址](https://github.com/acme/sforum-plugin/blob/HEAD/README.md)");
    expect(html).toContain('href="https://github.com/acme/sforum-plugin/blob/HEAD/README.md"');
    expect(html).toContain('rel="nofollow noopener noreferrer ugc"');
    expect(html).toContain('target="_blank"');
  });
});

describe("releaseNotesHtml", () => {
  test("returns null for a release without a body", () => {
    expect(releaseNotesHtml(null, REPO)).toBeNull();
    expect(releaseNotesHtml("", REPO)).toBeNull();
    // Whitespace-only bodies would otherwise render an empty paragraph block.
    expect(releaseNotesHtml("   \n\t", REPO)).toBeNull();
  });

  test("renders the body once and serves the same HTML from the memo", () => {
    const first = releaseNotesHtml("## 变更", REPO);
    const second = releaseNotesHtml("## 变更", REPO);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("keeps one repository's resolution out of another's", () => {
    const mine = releaseNotesHtml("![a](./a.png)", "acme/one");
    const other = releaseNotesHtml("![a](./a.png)", "acme/two");
    expect(mine).toContain("raw.githubusercontent.com/acme/one/HEAD/a.png");
    expect(other).toContain("raw.githubusercontent.com/acme/two/HEAD/a.png");
  });

  test("stays bounded: the memo is per-process, so it drops the oldest entry", () => {
    // 200 entries are kept; the 201st evicts the first. Re-rendering the evicted body has to
    // still produce the same HTML — eviction is a memory decision, never a correctness one.
    const first = releaseNotesHtml("body-0", REPO);
    for (let index = 1; index < 201; index += 1) {
      releaseNotesHtml(`body-${index}`, REPO);
    }
    expect(releaseNotesHtml("body-0", REPO)).toBe(first!);
  });
});

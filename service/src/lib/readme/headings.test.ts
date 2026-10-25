import { describe, expect, test } from "bun:test";

import { renderReadme } from "./render";
import { extractHeadings } from "./headings";

function render(markdown: string): string {
  return renderReadme({
    source: markdown,
    repoFullName: "acme/sforum-plugin",
    path: "README.md",
    format: "markdown",
  });
}

describe("extractHeadings", () => {
  test("reads id, label and level out of the rendered document", () => {
    const headings = extractHeadings(render("# Title\n\n## 安装\n\n### 细节"));
    // `#` is clamped to `h2`, so the title and a `##` section share a level; the document
    // title is separated visually (`.readme > h2:first-child`), not structurally.
    expect(headings).toEqual([
      { id: "title", label: "Title", level: 2 },
      { id: "安装", label: "安装", level: 2 },
      { id: "细节", label: "细节", level: 3 },
    ]);
  });

  test("drops the permalink anchor from the label", () => {
    const [heading] = extractHeadings(render("## 安装"));
    expect(heading?.label).toBe("安装");
    expect(heading?.label).not.toContain("#");
  });

  test("keeps inline code in the label and decodes entities", () => {
    const [heading] = extractHeadings(render("## 用 `bun run dev` 启动 & 调试"));
    expect(heading?.label).toBe("用 bun run dev 启动 & 调试");
  });

  test("ignores a heading without an id and an empty heading", () => {
    const headings = extractHeadings(
      '<h2>no id</h2><h2 id="kept">kept</h2><h3 id="blank"> </h3>',
    );
    expect(headings).toEqual([{ id: "kept", label: "kept", level: 2 }]);
  });

  test("returns nothing for a document with no headings", () => {
    expect(extractHeadings(render("just prose"))).toEqual([]);
  });
});

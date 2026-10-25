import { describe, expect, test } from "bun:test";

import { extractSummary } from "./summary";

describe("extractSummary", () => {
  test("takes the first prose paragraph and skips the title", () => {
    const summary = extractSummary(
      ["# Markdown Plus", "", "补齐 GFM 语法：表格、任务列表、脚注。", "", "## Features"].join("\n"),
    );
    expect(summary).toBe("补齐 GFM 语法：表格、任务列表、脚注。");
  });

  test("skips badges, rules and HTML comments before the paragraph", () => {
    const summary = extractSummary(
      [
        "[![build](https://img.shields.io/badge/build-pass-green)](https://ci.example.com)",
        "[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)",
        "",
        "---",
        "",
        "<!-- generated -->",
        "",
        "A narrow reading layout with no external fonts.",
      ].join("\n"),
    );
    expect(summary).toBe("A narrow reading layout with no external fonts.");
  });

  test("drops frontmatter", () => {
    const summary = extractSummary(
      ["---", "title: x", "tags: [a]", "---", "", "Body sentence."].join("\n"),
    );
    expect(summary).toBe("Body sentence.");
  });

  test("skips a leading code fence", () => {
    const summary = extractSummary(
      ["```bash", "npm install x", "```", "", "Installs the extension."].join("\n"),
    );
    expect(summary).toBe("Installs the extension.");
  });

  test("strips list markers and task checkboxes", () => {
    const summary = extractSummary(
      ["## What", "", "- [x] tables", "- [ ] footnotes"].join("\n"),
    );
    expect(summary).toBe("tables footnotes");
  });

  test("flattens inline links, code and emphasis", () => {
    const summary = extractSummary(
      "Works with **SForum** `1.2+` and see [docs](https://example.com/docs).",
    );
    expect(summary).toBe("Works with SForum 1.2+ and see docs.");
  });

  test("cuts at a sentence boundary near the limit", () => {
    const first = "甲".repeat(200);
    const second = "乙".repeat(200);
    const summary = extractSummary(`${first}。${second}。`, 300);
    expect(summary).toBe(`${first}。`);
  });

  test("hard-cuts with an ellipsis when no sentence ends near the limit", () => {
    const summary = extractSummary("字".repeat(400), 300);
    expect(summary.length).toBe(301);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("returns an empty string when there is no prose", () => {
    expect(extractSummary("# Only a heading\n\n## Another")).toBe("");
    expect(extractSummary("")).toBe("");
  });

  test("decodes the entities a first paragraph realistically uses", () => {
    const summary = extractSummary("Tools &amp; themes for &quot;SForum&quot;.");
    expect(summary).toBe('Tools & themes for "SForum".');
  });

  test("does not keep an image alt as prose", () => {
    const summary = extractSummary("![screenshot](./docs/a.png)\n\nReal sentence.");
    expect(summary).toBe("Real sentence.");
  });
});

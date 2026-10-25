import { describe, expect, test } from "bun:test";

import { pushTouchesBrand, type PushPayload } from "./push-filter";

/**
 * The `push` subscription exists only to notice `brand/` edits. Getting this predicate wrong
 * has a cost in both directions: a false negative means the catalog shows yesterday's icon
 * until the next release, a false positive means every push to every repository wakes the
 * worker up for one conditional API call.
 */

const base = (overrides: Partial<PushPayload> = {}): PushPayload => ({
  ref: "refs/heads/main",
  size: 1,
  commits: [{ added: ["README.md"] }],
  repository: { id: 1, default_branch: "main" },
  ...overrides,
});

describe("pushTouchesBrand", () => {
  test("a brand edit on the default branch qualifies", () => {
    expect(
      pushTouchesBrand(
        base({ commits: [{ modified: ["brand/icon.png"] }, { added: ["brand/social-preview.png"] }] }),
      ),
    ).toBe(true);
  });

  test("a nested package directory qualifies — that is how plugin repos lay it out", () => {
    expect(
      pushTouchesBrand(
        base({
          commits: [
            { modified: ["plugins/sforum-oauth2-provider/brand/icon.png"] },
          ],
        }),
      ),
    ).toBe(true);
  });

  test("a path that merely mentions brand is not the directory", () => {
    expect(pushTouchesBrand(base({ commits: [{ added: ["docs/branding.md"] }] }))).toBe(false);
    expect(pushTouchesBrand(base({ commits: [{ added: ["src/brand-icon.ts"] }] }))).toBe(false);
  });

  test("other branches never qualify", () => {
    expect(
      pushTouchesBrand(base({ ref: "refs/heads/feature/x", commits: [{ added: ["brand/icon.png"] }] })),
    ).toBe(false);
    expect(pushTouchesBrand(base({ ref: "refs/tags/v1.0.0" }))).toBe(false);
  });

  test("a branch deletion is ignored", () => {
    expect(pushTouchesBrand(base({ deleted: true, commits: [] }))).toBe(false);
  });

  test("a truncated commit list is treated as touched rather than guessed", () => {
    // GitHub caps the commit array; a large push must not be read as "nothing changed".
    expect(
      pushTouchesBrand(base({ size: 40, commits: [{ added: ["docs/a.md"] }] })),
    ).toBe(true);
  });

  test("a branch creation with no commits is still worth one conditional read", () => {
    expect(pushTouchesBrand(base({ size: 0, commits: [] }))).toBe(true);
  });

  test("head_commit alone is enough to qualify", () => {
    expect(
      pushTouchesBrand(
        base({ size: 1, commits: [], head_commit: { modified: ["brand/icon.svg"] } }),
      ),
    ).toBe(true);
  });

  test("a payload without a repository or default branch is ignored", () => {
    expect(pushTouchesBrand(base({ repository: null }))).toBe(false);
    expect(pushTouchesBrand(base({ repository: { id: 1 } }))).toBe(false);
    expect(pushTouchesBrand(base({ ref: undefined }))).toBe(false);
  });

  test("garbage in the commit array does not throw", () => {
    // Neither a null entry nor a non-array `added` is a path, so this is a no.
    expect(
      pushTouchesBrand(base({ commits: [null, 42, { added: "brand/icon.png" }] as unknown[] })),
    ).toBe(false);
  });
});

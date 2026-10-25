import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, getDb, getPool, type Db } from "@/db/client";
import { githubRepos, products, releaseVersions, repoReleases } from "@/db/schema";
import { TRUNCATE_ALL } from "@/lib/test-support/db";
import { WorkflowHint, WorkflowHintSlot } from "@/components/moderation/workflow-hint";
import { GithubAppClient, GithubError, type GithubWorkflowRun } from "./client";
import {
  fetchReviewWorkflowHint, interpretWorkflowRuns, loadReviewReleaseTarget, loadReviewWorkflowHint,
  verdictOf, type ReviewWorkflowHint, type WorkflowRunsClient,
} from "./actions";

// Plan §7.4 item 25 is optional and non-gating: these tests pin what the console shows when
// GitHub answers, and — more importantly — that it shows nothing and throws nothing otherwise.
// No test touches the network.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://store:store_dev_only@127.0.0.1:15432/sforum_store_test_b";
const SHA = "a".repeat(40);

let db: Db;
let counter = 0;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  db = getDb();
  await migrate(db, {
    migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname,
  });
});
beforeEach(async () => {
  counter = 0;
  await getPool().query(TRUNCATE_ALL);
});
afterAll(async () => {
  await closeDb();
});

type BoundProduct = {
  productId: string;
  repoId: number;
  versionId: string;
  installationId: number;
};

/** Pending product + pending version + GitHub repo row + the release it was synced from. */
async function makeBoundProduct(
  fixture: {
    repoId?: number | null;
    versionState?: "candidate" | "pending_review" | "published";
    version?: string;
    createdAt?: Date;
  } = {},
): Promise<BoundProduct> {
  counter += 1;
  const repoId = fixture.repoId === undefined ? 700 + counter : (fixture.repoId ?? 0);
  const version = fixture.version ?? `1.${counter}.0`;
  const installationId = 70 + counter;

  await db.insert(githubRepos).values({ repoId, installationId, fullName: `acme/ext-${counter}` });
  const [product] = await db
    .insert(products)
    .values({
      extensionId: `sforum.actions-${counter}`,
      name: `Actions ${counter}`,
      kind: "plugin",
      slug: `actions-${counter}`,
      repoId: fixture.repoId === null ? null : repoId,
      status: "pending_review",
      defaultLocale: "zh-CN",
    })
    .returning({ id: products.id });
  // `target_commitish` records what the author typed (usually a branch); the hint resolves the
  // tag instead of trusting it.
  const [release] = await db
    .insert(repoReleases)
    .values({ repoId, githubReleaseId: 20_000 + counter, tag: `v${version}`, targetCommitish: "main" })
    .returning({ id: repoReleases.id });
  const [row] = await db
    .insert(releaseVersions)
    .values({
      productId: product!.id,
      repoReleaseId: release!.id,
      version,
      channel: "stable",
      state: fixture.versionState ?? "pending_review",
      sforumVersionConstraint: ">=1.0.0",
      createdAt: fixture.createdAt ?? new Date("2026-10-20T00:00:00Z"),
    })
    .returning({ id: releaseVersions.id });

  return { productId: product!.id, repoId, versionId: row!.id, installationId };
}

function makeRun(over: Partial<GithubWorkflowRun> & { id: number }): GithubWorkflowRun {
  return {
    name: "CI",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/acme/ext/actions/runs/${over.id}`,
    run_started_at: "2026-10-24T09:00:00Z",
    created_at: "2026-10-24T08:59:00Z",
    ...over,
  };
}

function makeFakeClient(
  handlers: {
    sha?: (ref: string) => Promise<string>;
    runs?: (sha: string) => Promise<GithubWorkflowRun[]>;
  } = {},
) {
  const calls: { kind: "commit" | "runs"; ref: string; installationId: number }[] = [];
  const client: WorkflowRunsClient = {
    async getCommitSha(_repo, ref, installationId) {
      calls.push({ kind: "commit", ref, installationId });
      return handlers.sha ? handlers.sha(ref) : SHA;
    },
    async listWorkflowRunsForCommit(_repo, commitSha, installationId) {
      calls.push({ kind: "runs", ref: commitSha, installationId });
      return handlers.runs ? handlers.runs(commitSha) : [makeRun({ id: 1 })];
    },
  };
  return { client, calls };
}

const input = (bound: BoundProduct, versionId: string | null = bound.versionId) => ({
  productId: bound.productId,
  repoId: bound.repoId,
  versionId,
});

async function hintFor(bound: BoundProduct, fake: ReturnType<typeof makeFakeClient>) {
  return loadReviewWorkflowHint(db, input(bound), { client: fake.client });
}

// --- Skipped: nothing is asked, nothing is rendered ---

describe("hint — skipped cases", () => {
  test("未配置的 GitHub App：不请求 GitHub、静默省略", async () => {
    // The App is console configuration (2026-10-25), so "unconfigured" is "no row in
    // github_app_config" — the TRUNCATE in beforeEach guarantees exactly that. The hint path
    // now has to read the database to learn this; what must not happen is a network call.
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("no network in tests");
    }) as unknown as typeof fetch;

    try {
      const hint = await loadReviewWorkflowHint(db, {
        productId: "5f0f0f8a-3f2a-4f43-9d5b-0c3b1b1b1b1b",
        repoId: 901,
        versionId: null,
      });
      expect(hint).toBeNull();
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("没有绑定仓库：省略且一次请求都不发", async () => {
    const bound = await makeBoundProduct({ repoId: null });
    const fake = makeFakeClient();
    const hint = await loadReviewWorkflowHint(
      db,
      { productId: bound.productId, repoId: null, versionId: bound.versionId },
      { client: fake.client },
    );
    expect(hint).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("已绑定但没有等审版本：省略且不请求", async () => {
    const bound = await makeBoundProduct({ versionState: "published" });
    const fake = makeFakeClient();
    expect(await loadReviewReleaseTarget(db, { productId: bound.productId, versionId: bound.versionId })).toBeNull();
    expect(await hintFor(bound, fake)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("App 不认识这个仓库（无 github_repos 行）：省略且不请求", async () => {
    const bound = await makeBoundProduct();
    await getPool().query("DELETE FROM github_repos WHERE repo_id = $1", [bound.repoId]);
    const fake = makeFakeClient();
    expect(await hintFor(bound, fake)).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

// --- Displayed ---

describe("hint — displayed cases", () => {
  test("成功：给出结论、release、commit 与运行链接", async () => {
    const bound = await makeBoundProduct({ version: "1.4.2" });
    const fake = makeFakeClient({ runs: async () => [makeRun({ id: 41 })] });

    const hint = await hintFor(bound, fake);
    expect(hint).not.toBeNull();
    expect(hint).toMatchObject({
      verdict: "success",
      tag: "v1.4.2",
      version: "1.4.2",
      commitSha: SHA,
      runCount: 1,
    });
    expect(hint!.run.url).toBe("https://github.com/acme/ext/actions/runs/41");
    // The tag is resolved to a commit first; the runs query then filters by that sha.
    expect(fake.calls).toEqual([
      { kind: "commit", ref: "v1.4.2", installationId: bound.installationId },
      { kind: "runs", ref: SHA, installationId: bound.installationId },
    ]);
  });

  test("同一提交多个运行：取最差结论，链接指向决定结论的那一条", async () => {
    const bound = await makeBoundProduct();
    const fake = makeFakeClient({
      runs: async () => [
        makeRun({ id: 1, name: "lint" }),
        makeRun({ id: 2, name: "test", conclusion: "failure", run_started_at: "2026-10-24T10:00:00Z" }),
        makeRun({ id: 3, name: "docs", status: "in_progress", conclusion: null }),
      ],
    });

    const hint = await hintFor(bound, fake);
    expect(hint).toMatchObject({ verdict: "failure", runCount: 3 });
    expect(hint!.run.name).toBe("test");
    expect(hint!.run.url).toEndWith("/runs/2");
  });

  test("指定的版本优先于最新的那个", async () => {
    const older = await makeBoundProduct({
      version: "1.0.0",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const [newerRelease] = await db
      .insert(repoReleases)
      .values({ repoId: older.repoId, githubReleaseId: 99_001, tag: "v2.0.0" })
      .returning({ id: repoReleases.id });
    await db.insert(releaseVersions).values({
      productId: older.productId,
      repoReleaseId: newerRelease!.id,
      version: "2.0.0",
      channel: "stable",
      state: "pending_review",
      sforumVersionConstraint: ">=1.0.0",
      createdAt: new Date("2026-10-01T00:00:00Z"),
    });

    const focused = await loadReviewReleaseTarget(db, {
      productId: older.productId,
      versionId: older.versionId,
    });
    const fallback = await loadReviewReleaseTarget(db, {
      productId: older.productId,
      versionId: null,
    });

    expect(focused).toMatchObject({ version: "1.0.0", tag: "v1.0.0" });
    expect(fallback!.tag).toBe("v2.0.0");
  });
});

// --- Failure paths: always null, never a throw ---

describe("hint — failure paths", () => {
  test("404 / 401 / 403 / 网络错误：一律省略且不抛", async () => {
    const bound = await makeBoundProduct();
    const failures = [
      new GithubError(404, "Not Found"),
      new GithubError(401, "Bad credentials"),
      new GithubError(403, "Resource not accessible by integration"),
      new TypeError("fetch failed"),
    ];
    for (const failure of failures) {
      const viaCommit = makeFakeClient({ sha: async () => Promise.reject(failure) });
      const viaRuns = makeFakeClient({ runs: async () => Promise.reject(failure) });
      expect(await hintFor(bound, viaCommit)).toBeNull();
      expect(await hintFor(bound, viaRuns)).toBeNull();
    }
  });

  test("超时：短时间内省略且不抛", async () => {
    const bound = await makeBoundProduct();
    const fake = makeFakeClient({ sha: () => new Promise<string>(() => {}) });

    const started = Date.now();
    const hint = await loadReviewWorkflowHint(db, input(bound), {
      client: fake.client,
      timeoutMs: 40,
    });
    // The page budget is a hard cap: an unresolved fetch cannot hold the render open.
    expect(hint).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("响应形状不符：省略（不渲染半条信息）", async () => {
    const bound = await makeBoundProduct();
    const payloads: unknown[][] = [
      [],
      [{ id: "3", html_url: "https://github.com/x/y/actions/runs/3" }],
      [{ id: 4, html_url: "javascript:alert(1)", head_sha: SHA }],
      [{ id: 5, html_url: "https://github.com/x/y/actions/runs/5", head_sha: "b".repeat(40) }],
    ];
    for (const payload of payloads) {
      const fake = makeFakeClient({ runs: async () => payload as GithubWorkflowRun[] });
      expect(await hintFor(bound, fake)).toBeNull();
    }
  });

  test("fetchReviewWorkflowHint 自身不抛，直接返回 null", async () => {
    const hint = await fetchReviewWorkflowHint(
      {
        async getCommitSha() {
          throw new GithubError(500, "boom");
        },
        async listWorkflowRunsForCommit() {
          return [];
        },
      },
      { version: "1.0.0", tag: "v1.0.0", repoFullName: "acme/ext", installationId: 1 },
      { timeoutMs: 40 },
    );
    expect(hint).toBeNull();
  });
});

// --- Pure mapping ---

describe("workflow run mapping", () => {
  test("status/conclusion → 结论", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: "queued" }, "pending"],
      [{ status: "in_progress", conclusion: null }, "pending"],
      [{ status: "completed", conclusion: "success" }, "success"],
      [{ status: "completed", conclusion: "timed_out" }, "failure"],
      [{ status: "completed", conclusion: "cancelled" }, "neutral"],
      [{ status: "completed", conclusion: null }, "neutral"],
      [{}, "pending"],
    ];
    for (const [run, expected] of cases) expect(verdictOf(run)).toBe(expected as never);
  });

  test("最差结论优先，不做「有一条绿的就算过」", () => {
    const note = interpretWorkflowRuns(
      [
        makeRun({ id: 1 }),
        makeRun({ id: 2, conclusion: "skipped", name: "optional" }),
        makeRun({ id: 3, conclusion: "startup_failure" }),
      ],
      SHA,
    );
    expect(note).toMatchObject({ verdict: "failure", runCount: 3 });
    expect(note!.run.id).toBe(3);
  });

});

// --- The client's two read calls ---

describe("GithubAppClient workflow-run reads", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const config = {
    appId: 123, slug: "sforum-store", webhookSecret: "secret",
    privateKeys: new Map([["k1", privateKey]]), apiBaseUrl: "https://api.github.test",
  };
  const tokenResponse = () =>
    Response.json({
      token: "ghs_1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

  function clientWith(body: (path: string) => Response) {
    const paths: string[] = [];
    const client = new GithubAppClient(config, {
      fetchImpl: async (input: string | URL | Request) => {
        const path = String(input).replace("https://api.github.test", "");
        paths.push(path);
        return path.endsWith("/access_tokens") ? tokenResponse() : body(path);
      },
    });
    return { client, paths };
  }

  test("解析 tag 到 commit，并按 head_sha 取运行记录", async () => {
    const { client, paths } = clientWith((path) => {
      if (path.includes("/commits/")) return Response.json({ sha: SHA });
      if (path.includes("/actions/runs")) {
        return Response.json({ total_count: 1, workflow_runs: [makeRun({ id: 7 })] });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(client.getCommitSha("o/r", "v1.0.0", 7)).resolves.toBe(SHA);
    expect(await client.listWorkflowRunsForCommit("o/r", SHA, 7)).toHaveLength(1);
    expect(paths).toContain("/repos/o/r/commits/v1.0.0");
    expect(paths).toContain(`/repos/o/r/actions/runs?head_sha=${SHA}&per_page=20`);
  });

  test("意外的响应形状抛 GithubError(502)，由上层吞掉", async () => {
    const { client } = clientWith(() => Response.json({ total_count: 0 }));
    await expect(client.listWorkflowRunsForCommit("o/r", SHA, 7)).rejects.toMatchObject({
      name: "GithubError",
      status: 502,
    });
  });
});

// --- Copy: the banned claim must not exist anywhere on this surface ---

/** Assembled from code points so the banned phrase itself never reaches the source tree. */
const BANNED_ZH = String.fromCharCode(0x5df2, 0x9a8c, 0x8bc1, 0x6784, 0x5efa);
const BANNED_EN = ["verified", "build"].join(" ");
const SOURCES = [
  new URL("./actions.ts", import.meta.url),
  new URL("./client.ts", import.meta.url),
  new URL("../../components/moderation/workflow-hint.tsx", import.meta.url),
  new URL("../../components/moderation/detail-panel.tsx", import.meta.url),
  new URL("../../app/moderation/page.tsx", import.meta.url),
];
const sampleHint: ReviewWorkflowHint = {
  verdict: "success",
  tag: "v1.4.2",
  version: "1.4.2",
  commitSha: SHA,
  runCount: 2,
  run: { id: 41, name: "CI", url: "https://github.com/acme/ext/actions/runs/41", status: "completed", conclusion: "success" },
};

describe("review copy", () => {
  test("源码里没有「已验证构建」及其英文等价", async () => {
    for (const file of SOURCES) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain(BANNED_ZH);
      expect(source.toLowerCase()).not.toContain(BANNED_EN);
    }
  });

  test("渲染文案说明它是参考信息，且不含该措辞", () => {
    const html = renderToStaticMarkup(createElement(WorkflowHint, { hint: sampleHint }));
    expect(html).toContain("GitHub Actions");
    expect(html).toContain("v1.4.2");
    expect(html).toContain("结论：成功");
    expect(html).toContain("参考信息，不参与审核判定");
    expect(html).toContain(sampleHint.run.url);
    expect(html).not.toContain(BANNED_ZH);
    expect(html.toLowerCase()).not.toContain(BANNED_EN);
  });

  test("没有结论时整块消失，不留空占位", async () => {
    expect(await WorkflowHintSlot({ hint: Promise.resolve(null) })).toBeNull();
    const node = await WorkflowHintSlot({ hint: Promise.resolve(sampleHint) });
    expect(renderToStaticMarkup(node)).toContain("参考信息，不参与审核判定");
  });
});

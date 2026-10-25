import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type { GithubConfig } from "@/lib/config";
import { GithubAppClient, type GithubRelease } from "./client";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const config: GithubConfig = {
  appId: 123,
  slug: "sforum-store",
  webhookSecret: "secret",
  privateKeys: new Map([["k1", privateKey]]),
  apiBaseUrl: "https://api.github.test",
};

const release: GithubRelease = {
  id: 9,
  tag_name: "v1.4.2",
  target_commitish: "main",
  prerelease: false,
  draft: false,
  body: "notes",
  assets: [],
};

describe("GithubAppClient", () => {
  test("caches installation tokens until the 60 second margin", async () => {
    let now = Date.UTC(2026, 9, 24, 0, 0, 0);
    let tokenCalls = 0;
    let releaseCalls = 0;
    let lastAuthorization = "";

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app/installations/7/access_tokens")) {
        tokenCalls += 1;
        return Response.json({
          token: `ghs_${tokenCalls}`,
          expires_at: new Date(now + 3600_000).toISOString(),
        });
      }
      if (url.endsWith("/repos/o/r/releases/9")) {
        releaseCalls += 1;
        return Response.json(release);
      }
      return new Response("not found", { status: 404 });
    };

    const client = new GithubAppClient(config, {
      fetchImpl: async (input, init) => {
        lastAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return fetchImpl(input);
      },
      now: () => now,
    });

    await client.getRelease("o/r", 9, 7);
    await client.getRelease("o/r", 9, 7);
    expect(tokenCalls).toBe(1);
    expect(releaseCalls).toBe(2);
    expect(lastAuthorization).toBe("Bearer ghs_1");

    now += 3600_000 - 30_000;
    await client.getRelease("o/r", 9, 7);
    expect(tokenCalls).toBe(2);
    expect(lastAuthorization).toBe("Bearer ghs_2");
  });

  test("decodes a README and keeps path and sha", async () => {
    const source = "# Title\n\n正文。";
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app/installations/7/access_tokens")) {
        return Response.json({
          token: "ghs_1",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url.endsWith("/repos/o/r/readme")) {
        return Response.json({
          path: "docs/README.md",
          sha: "abc123",
          size: Buffer.byteLength(source),
          encoding: "base64",
          content: Buffer.from(source, "utf8").toString("base64"),
        });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new GithubAppClient(config, { fetchImpl });
    const readme = await client.getReadme("o/r", 7);
    expect(readme).toEqual({ path: "docs/README.md", sha: "abc123", content: source });
  });

  test("reports a README that GitHub refuses to inline", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return Response.json({
          token: "ghs_1",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      return Response.json({
        path: "README.md",
        sha: "abc123",
        size: 5 * 1024 * 1024,
        encoding: "none",
        content: "",
      });
    };

    const client = new GithubAppClient(config, { fetchImpl });
    await expect(client.getReadme("o/r", 7)).rejects.toMatchObject({ status: 413 });
  });
});

describe("GithubAppClient.listRepoTree", () => {
  const token = () => new Response(JSON.stringify({ token: "ghs_1", expires_at: "2099-01-01T00:00:00Z" }));

  function clientWith(handler: (url: string) => Response) {
    return new GithubAppClient(config, {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/access_tokens")) return token();
        return handler(url);
      },
    });
  }

  test("keeps path and type, and reports truncation", async () => {
    const client = clientWith((url) => {
      expect(url).toContain("/repos/o/r/git/trees/main?recursive=1");
      return Response.json({
        sha: "tree-sha",
        truncated: true,
        tree: [
          { path: "plugins/a/sforum.extension.json", type: "blob" },
          { path: "plugins", type: "tree" },
          { path: 42, type: "blob" },
          null,
        ],
      });
    });

    const tree = await client.listRepoTree("o/r", 7, { ref: "main" });
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toEqual([
      { path: "plugins/a/sforum.extension.json", type: "blob" },
      { path: "plugins", type: "tree" },
    ]);
  });

  test("defaults the ref to HEAD and refuses an oversized listing", async () => {
    let seen = "";
    const client = clientWith((url) => {
      seen = url;
      return Response.json({ tree: [{ path: "a", type: "blob" }] });
    });
    await client.listRepoTree("o/r", 7);
    expect(seen).toContain("/git/trees/HEAD?recursive=1");

    const big = clientWith(() =>
      Response.json({ tree: [{ path: "x".repeat(2048), type: "blob" }] }),
    );
    await expect(
      big.listRepoTree("o/r", 7, { ref: "main", maxBytes: 1024 }),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("a body that is not a tree is a 502, not an empty listing", async () => {
    const client = clientWith(() => new Response("<html>nope</html>"));
    await expect(client.listRepoTree("o/r", 7, { ref: "main" })).rejects.toMatchObject({
      status: 502,
    });
  });
});

import { describe, expect, test } from "bun:test";

import { fetchSocialPreview } from "./social-preview";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PUBLIC = { apiBaseUrl: "https://api.github.com" };

function htmlPage(ogImage: string | null): Response {
  const meta =
    ogImage === null
      ? ""
      : `<meta property="og:image" content="${ogImage}" />`;
  return new Response(
    `<!doctype html><html><head>${meta}<title>repo</title></head><body></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}

function imageResponse(bytes: Buffer, type = "image/png"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": type } });
}

describe("fetchSocialPreview", () => {
  test("skips a GitHub Enterprise deployment", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      apiBaseUrl: "https://ghes.example.com/api/v3",
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(result).toEqual({ ok: false, reason: "ghes" });
  });

  test("rejects a name that is not owner/repo", async () => {
    for (const name of ["acme", "acme/", "../x", "acme/plug in", "a/b/c"]) {
      const result = await fetchSocialPreview(name, {
        ...PUBLIC,
        fetchImpl: async () => {
          throw new Error("must not fetch");
        },
      });
      expect(result).toEqual({ ok: false, reason: "invalid_repo_name" });
    }
  });

  test("returns the preview bytes for a public repository", async () => {
    const calls: string[] = [];
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://github.com/acme/plugin") {
          return htmlPage(
            "https://repository-images.githubusercontent.com/42/abc",
          );
        }
        if (url === "https://repository-images.githubusercontent.com/42/abc") {
          return imageResponse(PNG);
        }
        return new Response("nope", { status: 404 });
      },
    });
    expect(calls).toEqual([
      "https://github.com/acme/plugin",
      "https://repository-images.githubusercontent.com/42/abc",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.mime).toBe("image/png");
    expect(result.preview.width).toBe(1);
    expect(result.preview.sourceUrl).toBe(
      "https://repository-images.githubusercontent.com/42/abc",
    );
  });

  test("reads og:image when content comes before property", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith("https://github.com/")) {
          return new Response(
            '<html><head><meta content="https://repository-images.githubusercontent.com/1/x" property="og:image"></head></html>',
            { status: 200 },
          );
        }
        return imageResponse(PNG);
      },
    });
    expect(result.ok).toBe(true);
  });

  test("reports no preview for a repository without one", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async () => htmlPage(null),
    });
    expect(result).toEqual({ ok: false, reason: "no_og_image" });
  });

  test("refuses an og:image on another host", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async () => htmlPage("https://evil.example/x.png"),
    });
    expect(result).toEqual({ ok: false, reason: "untrusted_host" });
  });

  test("treats an anonymous 404 as no preview", async () => {
    const result = await fetchSocialPreview("acme/private", {
      ...PUBLIC,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });
    expect(result).toEqual({ ok: false, reason: "http_error" });
  });

  test("rejects a page that exceeds the byte cap", async () => {
    const huge = `<html>${"x".repeat(2 * 1024 * 1024 + 1)}</html>`;
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async () => new Response(huge, { status: 200 }),
    });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  test("rejects bytes that are not an accepted bitmap", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith("https://github.com/")) {
          return htmlPage("https://repository-images.githubusercontent.com/1/x");
        }
        return imageResponse(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml");
      },
    });
    expect(result).toEqual({ ok: false, reason: "unsupported_image" });
  });

  test("reports a network failure without throwing", async () => {
    const result = await fetchSocialPreview("acme/plugin", {
      ...PUBLIC,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(result).toEqual({ ok: false, reason: "network" });
  });
});

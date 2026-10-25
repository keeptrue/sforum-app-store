import { describe, expect, test } from "bun:test";

import { AdminError } from "@/lib/admin/errors";

import {
  buildGithubAppManifest,
  decodeManifestState,
  defaultAppName,
  encodeManifestState,
  exchangeManifestCode,
  isGithubDotCom,
  MANIFEST_EVENTS,
  MANIFEST_PERMISSIONS,
  manifestCallbackUrl,
  manifestConversionsUrl,
  manifestStartUrl,
  verifyManifestState,
  webHostFor,
} from "./manifest";

const secret = "s".repeat(64);
const publicUrl = "https://test-sforum-app-store.dalao.me";

const state = {
  adminId: "00000000-0000-0000-0000-000000000001",
  nonce: "nonce-1",
  exp: Math.floor(Date.now() / 1000) + 600,
};

async function catchAdminError(fn: () => Promise<unknown>): Promise<AdminError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AdminError) return error;
    throw error;
  }
  throw new Error("expected the call to throw an AdminError");
}

function fakeFetch(
  status: number,
  body: unknown,
): { calls: string[]; fetchImpl: (url: string) => Promise<Response> } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("manifest state", () => {
  test("round-trips a signed state", () => {
    const encoded = encodeManifestState(state, secret);
    expect(decodeManifestState(encoded, secret)).toEqual(state);
  });

  test("rejects a different secret, tampering and expiry", () => {
    const encoded = encodeManifestState(state, secret);
    expect(decodeManifestState(encoded, "x".repeat(64))).toBeNull();
    expect(decodeManifestState(`${encoded}x`, secret)).toBeNull();
    expect(decodeManifestState("not-a-token", secret)).toBeNull();

    const expired = encodeManifestState(
      { ...state, exp: Math.floor(Date.now() / 1000) - 1 },
      secret,
    );
    expect(decodeManifestState(expired, secret)).toBeNull();
  });

  test("refuses a state without an admin id", () => {
    const signed = encodeManifestState({ ...state, adminId: "" }, secret);
    expect(decodeManifestState(signed, secret)).toBeNull();
  });
});

describe("the manifest we ask GitHub to build", () => {
  const manifest = buildGithubAppManifest({
    name: "sforum-store-test",
    publicUrl,
    webhookUrl: `${publicUrl}/api/github/webhook`,
    setupUrl: `${publicUrl}/api/github/setup`,
    redirectUrl: manifestCallbackUrl(publicUrl),
  });

  test("carries the addresses the console would otherwise ask a human to retype", () => {
    expect(manifest.url).toBe(publicUrl);
    expect(manifest.hook_attributes).toEqual({
      url: `${publicUrl}/api/github/webhook`,
      active: true,
    });
    expect(manifest.setup_url).toBe(`${publicUrl}/api/github/setup`);
    expect(manifest.redirect_url).toBe(`${publicUrl}/api/github/manifest/callback`);
  });

  test("asks for read-only contents/metadata/actions and never administration", () => {
    expect(manifest.default_permissions).toEqual(MANIFEST_PERMISSIONS);
    expect(Object.keys(manifest.default_permissions)).not.toContain("administration");
  });

  test("subscribes to repository, not just release", () => {
    expect(manifest.default_events).toEqual([...MANIFEST_EVENTS]);
    expect(manifest.default_events).toContain("repository");
    expect(manifest.default_events).toContain("release");
  });

  /**
   * Regression guard. GitHub rejected the first version of this manifest with
   * "Default events unsupported: installation and installation_repositories" — those two are
   * delivered to every App as part of the installation lifecycle and cannot be subscribed to,
   * so naming them makes the whole manifest invalid.
   */
  test("never names the installation lifecycle events", () => {
    expect(manifest.default_events).not.toContain("installation");
    expect(manifest.default_events).not.toContain("installation_repositories");
  });

  test("is a public App: a private one can only be installed by its owner", () => {
    expect(manifest.public).toBe(true);
  });

  test("does not ask for user OAuth: the store authenticates as an installation", () => {
    expect(manifest.request_oauth_on_install).toBe(false);
  });
});

describe("addresses", () => {
  test("github.com and a GHES api base resolve to different web hosts", () => {
    expect(webHostFor("https://api.github.com")).toBe("https://github.com");
    expect(isGithubDotCom("https://api.github.com/")).toBe(true);
    expect(webHostFor("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com");
    expect(isGithubDotCom("https://ghe.example.com/api/v3")).toBe(false);
  });

  test("the start URL switches between a personal and an organization account", () => {
    expect(manifestStartUrl("https://github.com", "abc123")).toBe(
      "https://github.com/settings/apps/new?state=abc123",
    );
    expect(manifestStartUrl("https://github.com", "abc123", "sforum")).toBe(
      "https://github.com/organizations/sforum/settings/apps/new?state=abc123",
    );
  });

  test("conversions endpoint is derived from the api base", () => {
    expect(manifestConversionsUrl("https://api.github.com", "code-1")).toBe(
      "https://api.github.com/app-manifests/code-1/conversions",
    );
    expect(manifestConversionsUrl("https://ghe.example.com/api/v3/", "code-1")).toBe(
      "https://ghe.example.com/api/v3/app-manifests/code-1/conversions",
    );
  });

  test("a suggested name is short, host-derived and stable", () => {
    const name = defaultAppName(publicUrl);
    expect(name).toBe(defaultAppName(publicUrl));
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name).toMatch(/^[a-z0-9-]+$/);

    // A short host label is readable; a long one falls back to a hash instead of overflowing.
    expect(defaultAppName("https://shop.example.com")).toBe("sforum-store-shop");
    expect(defaultAppName(publicUrl)).not.toContain("test-sforum-app-store");
  });
});

describe("exchanging the temporary code", () => {
  const conversion = {
    id: 424242,
    slug: "sforum-store-test",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
    webhook_secret: "e340154128314309424b7c8e90325147d99fdafa",
    html_url: "https://github.com/apps/sforum-store-test",
    owner: { login: "sforum" },
  };

  test("returns the four values the console would otherwise ask for", async () => {
    const fake = fakeFetch(201, conversion);
    const result = await exchangeManifestCode({
      apiBaseUrl: "https://api.github.com",
      code: "code-1",
      fetchImpl: fake.fetchImpl,
    });

    expect(result).toEqual({
      appId: 424242,
      slug: "sforum-store-test",
      pem: conversion.pem,
      webhookSecret: conversion.webhook_secret,
      htmlUrl: "https://github.com/apps/sforum-store-test",
      owner: "sforum",
    });
    expect(fake.calls[0]).toBe("https://api.github.com/app-manifests/code-1/conversions");
  });

  test("a spent or expired code is reported as such, not as a crash", async () => {
    const fake = fakeFetch(404, { message: "Not Found" });
    const error = await catchAdminError(() =>
      exchangeManifestCode({
        apiBaseUrl: "https://api.github.com",
        code: "code-1",
        fetchImpl: fake.fetchImpl,
      }),
    );
    expect(error.code).toBe("manifest_exchange_failed");
    expect(error.message).toContain("过期");
  });

  test("an incomplete answer never reaches the database", async () => {
    for (const patch of [
      { pem: "" },
      { webhook_secret: "" },
      { slug: "-bad-slug" },
      { id: 0 },
    ]) {
      const fake = fakeFetch(201, { ...conversion, ...patch });
      const error = await catchAdminError(() =>
        exchangeManifestCode({
          apiBaseUrl: "https://api.github.com",
          code: "code-1",
          fetchImpl: fake.fetchImpl,
        }),
      );
      expect(error.code).toBe("manifest_invalid_response");
    }
  });

  test("an empty code is refused before any request goes out", async () => {
    const fake = fakeFetch(201, conversion);
    const error = await catchAdminError(() =>
      exchangeManifestCode({
        apiBaseUrl: "https://api.github.com",
        code: "   ",
        fetchImpl: fake.fetchImpl,
      }),
    );
    expect(error.code).toBe("manifest_missing_code");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("callback state verification", () => {
  const token = encodeManifestState(state, secret);

  test("accepts the token we issued when the query carries it back", () => {
    expect(verifyManifestState(token, token, secret)).toEqual(state);
  });

  /**
   * Regression: the callback compared the decoded `nonce` with the query, which is the whole
   * signed token — never equal. Every real callback answered `reason=state`, and the App
   * GitHub had just created was left orphaned.
   */
  test("rejects a different query value, a bare nonce, a missing cookie and a bad signature", () => {
    const other = encodeManifestState({ ...state, nonce: "nonce-2" }, secret);
    expect(verifyManifestState(token, other, secret)).toBeNull();
    expect(verifyManifestState(token, state.nonce, secret)).toBeNull();
    expect(verifyManifestState(token, null, secret)).toBeNull();
    expect(verifyManifestState(null, token, secret)).toBeNull();
    expect(verifyManifestState(token, token, "x".repeat(64))).toBeNull();
  });
});

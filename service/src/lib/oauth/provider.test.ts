import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { startFakeProvider } from "../../../test/fake-provider";
import { challengeFor } from "./pkce";
import { OAuthError, SforumOAuthClient } from "./provider";

// 43 characters: the provider's `token.request.json` declares
// `code_verifier: minLength 43` and the Host validates it before the handler.
const verifier = "verifier-for-provider-test-0123456789abcdefg";
const redirectUri = "http://127.0.0.1:3000/api/auth/sforum/callback";

let fake: ReturnType<typeof startFakeProvider>;
let client: SforumOAuthClient;

beforeAll(() => {
  fake = startFakeProvider();
  client = new SforumOAuthClient({
    baseUrl: fake.url,
    clientId: "store-client",
    clientSecret: "dev-secret",
    scopes: ["profile", "avatar"],
  });
});

afterAll(() => {
  fake.server.stop(true);
});

describe("SforumOAuthClient", () => {
  test("exchanges a code with CSRF cookie/header, origin and body credentials", async () => {
    const code = fake.issueCode({
      user: { sub: "1", username: "lin", name: "Lin" },
      redirectUri,
      challenge: challengeFor(verifier),
    });

    const tokens = await client.exchangeCode({ code, redirectUri, verifier });
    expect(tokens.access_token.startsWith("at_")).toBe(true);
    expect(tokens.refresh_token?.startsWith("rt_")).toBe(true);

    const request = fake.state.lastTokenRequest;
    expect(request).not.toBeNull();
    expect(request?.headers["x-csrf-token"]).toBeTruthy();
    expect(request?.headers["cookie"]).toContain("csrf_=");
    expect(request?.headers["origin"]).toBe(fake.url);
    expect(request?.headers["authorization"]).toBeUndefined();
    // The provider route contract is JSON with `additionalProperties: false`;
    // a form-encoded body is rejected by the Host with 422 before OAuth runs.
    expect(request?.headers["content-type"]).toContain("application/json");
    expect(request?.body["client_id"]).toBe("store-client");
    expect(request?.body["client_secret"]).toBe("dev-secret");
    expect(request?.body["code_verifier"]).toBe(verifier);

    const user = await client.userinfo(tokens.access_token);
    expect(user.sub).toBe("1");
    expect(user.username).toBe("lin");
  });

  test("rotates the refresh token and revokes it", async () => {
    const code = fake.issueCode({
      user: { sub: "2" },
      redirectUri,
      challenge: challengeFor(verifier),
    });
    const tokens = await client.exchangeCode({ code, redirectUri, verifier });
    const before = fake.state.refreshRotations;

    const next = await client.refresh(tokens.refresh_token!);
    expect(fake.state.refreshRotations).toBe(before + 1);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    await client.revoke(next.refresh_token!);
    expect(fake.state.revoked.length).toBeGreaterThan(0);
  });

  test("surfaces revoke's camelCase errorDescription", async () => {
    const wrongSecret = new SforumOAuthClient({
      baseUrl: fake.url,
      clientId: "store-client",
      clientSecret: "not-dev-secret",
      scopes: ["profile"],
    });

    let caught: OAuthError | null = null;
    try {
      await wrongSecret.revoke("rt_revoke_probe");
    } catch (error) {
      caught = error as OAuthError;
    }
    expect(caught?.code).toBe("invalid_client");
    expect(caught?.status).toBe(401);
    expect(caught?.detail).toBe("client authentication failed");
  });

  test("maps the provider's camelCase userinfo fields", async () => {
    const code = fake.issueCode({
      user: {
        sub: "7",
        username: "qi",
        name: "Qi",
        avatar_url: "https://example.com/qi.png",
        email: "qi@example.com",
        email_verified: true,
      },
      redirectUri,
      challenge: challengeFor(verifier),
    });
    const tokens = await client.exchangeCode({ code, redirectUri, verifier });
    const user = await client.userinfo(tokens.access_token);

    // The live provider sends displayName / avatar / emailVerified.
    expect(user.name).toBe("Qi");
    expect(user.avatar_url).toBe("https://example.com/qi.png");
    expect(user.email).toBe("qi@example.com");
    expect(user.email_verified).toBe(true);
  });

  test("the fake rejects a token request without CSRF material", async () => {
    const response = await fetch(`${fake.url}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: "store-client" }),
    });
    expect(response.status).toBe(403);
  });

  test("a form-encoded token request is a route schema violation, not an OAuth error", async () => {
    // Regression guard: this is exactly what the live Host answered (422
    // `extensions.route_schema_invalid`) when the client posted a form body.
    const csrf = await fetch(`${fake.url}/api/oauth/csrf`);
    const cookieToken = (csrf.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .slice("csrf_=".length);

    const response = await fetch(`${fake.url}/api/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": cookieToken,
        cookie: `csrf_=${cookieToken}`,
        origin: fake.url,
      },
      body: "grant_type=authorization_code&client_id=store&client_secret=dev-secret",
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      data?: { reason?: string };
    };
    expect(body.data?.reason).toBe("extensions.route_schema_invalid");
  });
});

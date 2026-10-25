import { createHash } from "node:crypto";

export type FakeUser = {
  sub: string;
  username?: string;
  name?: string;
  avatar_url?: string;
  email?: string;
  email_verified?: boolean;
};

type CodeEntry = {
  challenge: string;
  redirectUri: string;
  user: FakeUser;
};

/**
 * Mirrors the Host's answer when a plugin route request fails the declared
 * request schema (`extensions.route_schema_invalid`, HTTP 422). The real Host
 * validates before the provider handler runs, so a wrong content type or an
 * undeclared field never reaches OAuth logic — see
 * `sforum-oauth2-provider` `schemas/token.request.json` (JSON,
 * `additionalProperties: false`).
 */
const ROUTE_SCHEMA_INVALID = {
  status: 422,
  body: {
    code: 422,
    message: "插件路由数据未通过已声明的契约校验。",
    data: { reason: "extensions.route_schema_invalid" },
  },
} as const;

type BodySchema = {
  allowed: readonly string[];
  required: readonly string[];
  minLength?: Readonly<Record<string, number>>;
  enums?: Readonly<Record<string, readonly string[]>>;
};

const TOKEN_SCHEMA: BodySchema = {
  allowed: [
    "grant_type",
    "client_id",
    "client_secret",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token",
    "scope",
  ],
  required: ["grant_type", "client_id"],
  minLength: { code_verifier: 43 },
  enums: { grant_type: ["authorization_code", "refresh_token"] },
};

const REVOKE_SCHEMA: BodySchema = {
  allowed: ["token", "token_type_hint", "client_id", "client_secret"],
  required: ["token"],
  minLength: { token: 8 },
  enums: { token_type_hint: ["access_token", "refresh_token"] },
};

type SchemaResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false };

/**
 * Validates a request body the way the Host does: JSON only, no undeclared
 * properties, required fields present, and the same min lengths/enums the
 * provider's schemas declare.
 */
async function readSchemaBody(
  request: Request,
  schema: BodySchema,
): Promise<SchemaResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!schema.allowed.includes(key)) return { ok: false };
    if (typeof value !== "string") return { ok: false };
    values[key] = value;
  }

  for (const key of schema.required) {
    if (!values[key]) return { ok: false };
  }
  for (const [key, min] of Object.entries(schema.minLength ?? {})) {
    if (values[key] !== undefined && values[key].length < min) return { ok: false };
  }
  for (const [key, allowed] of Object.entries(schema.enums ?? {})) {
    if (values[key] !== undefined && !allowed.includes(values[key])) return { ok: false };
  }
  return { ok: true, values };
}

export function startFakeProvider(options: { port?: number } = {}) {
  const csrfTokens = new Set<string>();
  const codes = new Map<string, CodeEntry>();
  const accessTokens = new Map<string, FakeUser>();
  const refreshTokens = new Map<string, FakeUser>();
  const state = {
    refreshRotations: 0,
    revoked: [] as string[],
    lastTokenRequest: null as {
      headers: Record<string, string>;
      body: Record<string, string>;
    } | null,
  };

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;

      if (url.pathname === "/api/oauth/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const stateParam = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        if (!redirectUri || !stateParam || !challenge) {
          return new Response("missing authorize parameters", { status: 400 });
        }
        const code = `code_${crypto.randomUUID()}`;
        codes.set(code, {
          challenge,
          redirectUri,
          user: {
            sub: "1",
            username: "lin",
            name: "Lin",
            avatar_url: "https://example.com/avatar.png",
            email: "lin@example.com",
            email_verified: true,
          },
        });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", stateParam);
        return Response.redirect(target.toString(), 302);
      }

      if (url.pathname === "/api/oauth/csrf") {
        const token = `csrf_${crypto.randomUUID()}`;
        csrfTokens.add(token);
        return Response.json(
          { ok: true },
          {
            headers: {
              "set-cookie": `csrf_=${token}; Path=/; HttpOnly; SameSite=Lax`,
            },
          },
        );
      }

      if (
        url.pathname === "/api/oauth/token" ||
        url.pathname === "/api/oauth/revoke"
      ) {
        const cookieHeader = request.headers.get("cookie") ?? "";
        const headerToken = request.headers.get("x-csrf-token") ?? "";
        const cookieToken = cookieHeader
          .split(";")
          .map((item) => item.trim())
          .find((item) => item.startsWith("csrf_="))
          ?.slice("csrf_=".length);

        if (
          !cookieToken ||
          !headerToken ||
          cookieToken !== headerToken ||
          !csrfTokens.has(headerToken) ||
          request.headers.get("origin") !== origin ||
          request.headers.get("authorization")
        ) {
          return Response.json({ error: "csrf_failed" }, { status: 403 });
        }
        // The Host stores the token and accepts re-use inside its window; it does
        // not burn it per request, so neither does this fake.

        const revoking = url.pathname === "/api/oauth/revoke";
        const schema = await readSchemaBody(
          request,
          revoking ? REVOKE_SCHEMA : TOKEN_SCHEMA,
        );
        if (!schema.ok) {
          return Response.json(
            ROUTE_SCHEMA_INVALID.body,
            { status: ROUTE_SCHEMA_INVALID.status },
          );
        }
        const form = schema.values;
        if (!revoking) {
          state.lastTokenRequest = {
            headers: Object.fromEntries(request.headers.entries()),
            body: form,
          };
        }

        if (
          form["client_id"] !== "store-client" ||
          form["client_secret"] !== "dev-secret"
        ) {
          // `revoke` reports failures with `errorDescription` (camelCase), unlike
          // `token`'s `error_description`. Copied from the live provider.
          return revoking
            ? Response.json(
                {
                  error: "invalid_client",
                  errorDescription: "client authentication failed",
                  revoked: false,
                },
                { status: 401 },
              )
            : Response.json({ error: "invalid_client" }, { status: 401 });
        }

        if (revoking) {
          state.revoked.push(form["token"] ?? "");
          return Response.json({ revoked: true });
        }

        const grant = form["grant_type"];
        if (grant === "authorization_code") {
          const entry = codes.get(form["code"] ?? "");
          if (!entry) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          const challenge = createHash("sha256")
            .update(form["code_verifier"] ?? "")
            .digest("base64url");
          if (
            challenge !== entry.challenge ||
            form["redirect_uri"] !== entry.redirectUri
          ) {
            return Response.json(
              { error: "invalid_grant", error_description: "pkce" },
              { status: 400 },
            );
          }
          codes.delete(form["code"] ?? "");

          const accessToken = `at_${crypto.randomUUID()}`;
          const refreshToken = `rt_${crypto.randomUUID()}`;
          accessTokens.set(accessToken, entry.user);
          refreshTokens.set(refreshToken, entry.user);
          return Response.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "profile avatar",
          });
        }

        if (grant === "refresh_token") {
          const previous = form["refresh_token"] ?? "";
          const user = refreshTokens.get(previous);
          if (!user) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          refreshTokens.delete(previous);
          state.refreshRotations += 1;

          const accessToken = `at_${crypto.randomUUID()}`;
          const refreshToken = `rt_${crypto.randomUUID()}`;
          accessTokens.set(accessToken, user);
          refreshTokens.set(refreshToken, user);
          return Response.json({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "profile avatar",
          });
        }

        return Response.json(
          { error: "unsupported_grant_type" },
          { status: 400 },
        );
      }

      if (url.pathname === "/api/oauth/userinfo") {
        if (request.headers.get("authorization")) {
          return Response.json(
            { error: "authorization_header_not_allowed" },
            { status: 400 },
          );
        }
        const token = url.searchParams.get("access_token") ?? "";
        const user = accessTokens.get(token);
        if (!user) {
          return Response.json(
            { error: "invalid_token", error_description: "the access token is invalid or has expired" },
            { status: 401 },
          );
        }
        // Wire shape copied from the live provider (`userinfo.go` +
        // `schemas/userinfo.response.json`): camelCase, `avatar` not
        // `avatar_url`, `emailVerified` not `email_verified`.
        return Response.json({
          sub: user.sub,
          username: user.username ?? `user${user.sub}`,
          displayName: user.name ?? user.username ?? `User ${user.sub}`,
          status: "active",
          scope: "profile avatar",
          clientId: "store-client",
          ...(user.avatar_url ? { avatar: user.avatar_url } : {}),
          ...(user.email ? { email: user.email } : {}),
          ...(user.email !== undefined
            ? { emailVerified: user.email_verified === true }
            : {}),
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    state,
    issueCode(input: {
      user: FakeUser;
      redirectUri: string;
      challenge: string;
    }) {
      const code = `code_${crypto.randomUUID()}`;
      codes.set(code, input);
      return code;
    },
  };
}

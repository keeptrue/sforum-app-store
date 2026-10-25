export type IssuerConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
};

export type UserInfo = {
  sub: string;
  username?: string;
  name?: string;
  avatar_url?: string;
  email?: string;
  email_verified?: boolean;
};

export class OAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(code: string, status?: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function readSetCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") {
    return withGetter.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? raw.split(/,(?=[^;,\s]+=)/) : [];
}

/** First non-empty string among the candidates (live provider field first). */
function firstString(
  ...values: unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** First boolean among the candidates; `false` is a real answer, not "missing". */
function firstBoolean(
  ...values: unknown[]
): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function findCsrfCookie(setCookies: string[]): string | null {  for (const header of setCookies) {
    for (const part of header.split(";")) {
      const cookie = part.trim();
      if (cookie.startsWith("csrf_=")) return cookie.slice("csrf_=".length);
    }
  }
  return null;
}

export class SforumOAuthClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly issuer: IssuerConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = trimBase(issuer.baseUrl);
    this.origin = new URL(this.baseUrl).origin;
    this.fetchImpl = fetchImpl;
  }

  authorizeUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string {
    const url = new URL(`${this.baseUrl}/api/oauth/authorize`);
    url.searchParams.set("client_id", this.issuer.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.issuer.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async userinfo(accessToken: string): Promise<UserInfo> {
    const url = new URL(`${this.baseUrl}/api/oauth/userinfo`);
    url.searchParams.set("access_token", accessToken);

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new OAuthError(
        "oauth_userinfo_failed",
        response.status,
        String(body.error ?? ""),
      );
    }
    if (typeof body.sub !== "string" || body.sub.length === 0) {
      throw new OAuthError("oauth_userinfo_invalid", response.status);
    }

    return {
      sub: body.sub,
      username: typeof body.username === "string" ? body.username : undefined,
      // The live provider sends camelCase (`displayName`, `avatar`,
      // `emailVerified`) — see `sforum-oauth2-provider` `userinfo.go` and
      // `schemas/userinfo.response.json`. Snake_case stays as a fallback so an
      // older/different provider still maps.
      name: firstString(body.displayName, body.name),
      avatar_url: firstString(body.avatar, body.avatar_url),
      email: typeof body.email === "string" ? body.email : undefined,
      email_verified: firstBoolean(body.emailVerified, body.email_verified),
    };
  }

  async revoke(
    token: string,
    hint: "access_token" | "refresh_token" = "refresh_token",
  ): Promise<void> {
    await this.postWithCsrf("/api/oauth/revoke", {
      token,
      token_type_hint: hint,
    });
  }

  private async csrf(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/oauth/csrf`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new OAuthError("oauth_csrf_failed", response.status);
    }
    const cookie = findCsrfCookie(readSetCookies(response.headers));
    if (!cookie) {
      throw new OAuthError("oauth_csrf_missing", response.status);
    }
    return cookie;
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<TokenResponse> {
    const body = await this.postWithCsrf("/api/oauth/token", form);
    const accessToken = body.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new OAuthError("oauth_token_invalid");
    }
    return {
      access_token: accessToken,
      refresh_token:
        typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      token_type:
        typeof body.token_type === "string" ? body.token_type : "Bearer",
      expires_in:
        typeof body.expires_in === "number" ? body.expires_in : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
    };
  }

  private async postWithCsrf(
    path: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const csrf = await this.csrf();
    // The provider's plugin routes declare a JSON request body with
    // `additionalProperties: false` and per-field min/max lengths, and the Host
    // validates against that schema *before* the handler runs. Form encoding is
    // rejected with 422 `extensions.route_schema_invalid`; empty optional fields
    // would violate `minLength`. Verified against `sforum-oauth2-provider`
    // (`openapi/routes.yaml`, `schemas/token.request.json`, `revoke.request.json`).
    const payload: Record<string, string> = {
      ...form,
      client_id: this.issuer.clientId,
      client_secret: this.issuer.clientSecret,
    };
    for (const [key, value] of Object.entries(payload)) {
      if (value === "") delete payload[key];
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-csrf-token": csrf,
        origin: this.origin,
        cookie: `csrf_=${csrf}`,
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok || typeof body.error === "string") {
      // `token` errors use `error_description`; `revoke` uses `errorDescription`.
      const description =
        typeof body.error_description === "string"
          ? body.error_description
          : typeof body.errorDescription === "string"
            ? body.errorDescription
            : undefined;
      throw new OAuthError(
        typeof body.error === "string" ? body.error : "oauth_http_error",
        response.status,
        description,
      );
    }
    return body;
  }
}

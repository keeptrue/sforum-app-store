import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  accounts,
  oauthIssuers,
  oauthTokenSets,
  sessions,
  storeRoles,
} from "@/db/schema";
import type { StoreConfig } from "@/lib/config";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  sha256Hex,
} from "@/lib/crypto";
import {
  OAuthError,
  SforumOAuthClient,
  type TokenResponse,
  type UserInfo,
} from "@/lib/oauth/provider";

export type ActiveIssuer = {
  issuerKey: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

export type SessionAccount = {
  id: string;
  issuerKey: string;
  sub: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  emailVerified: boolean;
};

/**
 * Only roles that actually authorize something today. `store_roles.role='admin'` rows still
 * exist in old databases but grant nothing: administrator identity is local to the store
 * (decisions/2026-10-25-admin-local-identity.md). Keeping the union honest means no surface
 * can quietly start trusting a legacy row again.
 */
export type ActiveStoreRole = "moderator";

export type CurrentSession = {
  account: SessionAccount;
  roles: ActiveStoreRole[];
  expiresAt: Date;
};

function mapAccount(row: typeof accounts.$inferSelect): SessionAccount {
  return {
    id: row.id,
    issuerKey: row.issuerKey,
    sub: row.sub,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    email: row.email,
    emailVerified: row.emailVerified,
  };
}

export type IssuerSummary = {
  issuerKey: string;
  displayName: string;
};

/**
 * Every issuer a forum user may log in with. The store no longer bootstraps one from env:
 * the admin console is the only writer (decisions/2026-10-25-admin-local-identity.md).
 */
export async function listActiveIssuers(db: Db): Promise<IssuerSummary[]> {
  return db
    .select({ issuerKey: oauthIssuers.issuerKey, displayName: oauthIssuers.displayName })
    .from(oauthIssuers)
    .where(eq(oauthIssuers.status, "active"))
    .orderBy(oauthIssuers.displayName);
}

export async function loadActiveIssuer(
  db: Db,
  config: StoreConfig,
  issuerKey: string,
): Promise<ActiveIssuer> {
  const [row] = await db
    .select()
    .from(oauthIssuers)
    .where(
      and(
        eq(oauthIssuers.issuerKey, issuerKey),
        eq(oauthIssuers.status, "active"),
      ),
    )
    .limit(1);

  if (!row) throw new Error(`active issuer "${issuerKey}" not found`);

  return {
    issuerKey: row.issuerKey,
    baseUrl: row.baseUrl,
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecretCiphertext, config.keyring),
    scopes: row.scopes,
  };
}

export async function upsertAccount(
  db: Db,
  issuerKey: string,
  user: UserInfo,
): Promise<typeof accounts.$inferSelect> {
  const [row] = await db
    .insert(accounts)
    .values({
      issuerKey,
      sub: user.sub,
      username: user.username ?? null,
      displayName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
      email: user.email ?? null,
      emailVerified: user.email_verified ?? false,
    })
    .onConflictDoUpdate({
      target: [accounts.issuerKey, accounts.sub],
      set: {
        username: user.username ?? null,
        displayName: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
        email: user.email ?? null,
        emailVerified: user.email_verified ?? false,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error("account upsert returned no row");
  return row;
}

/**
 * Roles that participate in authorization, read from `store_roles`.
 *
 * The `admin` rows written by the S1 bootstrap are deliberately filtered out here instead of
 * being trusted: the store's administrator is a local account in `admin_accounts`, and a
 * forum identity must never inherit that power from a leftover row.
 */
export async function getRoles(
  db: Db,
  accountId: string,
): Promise<ActiveStoreRole[]> {
  const rows = await db
    .select({ role: storeRoles.role })
    .from(storeRoles)
    .where(and(eq(storeRoles.accountId, accountId), eq(storeRoles.role, "moderator")));
  // The column's enum still carries `admin`, so narrow it here as well as in SQL.
  return rows
    .map((row) => row.role)
    .filter((role): role is ActiveStoreRole => role === "moderator");
}

export async function createSession(
  db: Db,
  accountId: string,
  input: {
    ttlSeconds: number;
    userAgent?: string | null;
    ip?: string | null;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await db.insert(sessions).values({
    accountId,
    tokenHash: sha256Hex(token),
    expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
  return { token, expiresAt };
}

export async function findSession(
  db: Db,
  token: string,
): Promise<CurrentSession | null> {
  const [row] = await db
    .select({ session: sessions, account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(sessions.accountId, accounts.id))
    .where(eq(sessions.tokenHash, sha256Hex(token)))
    .limit(1);

  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }

  return {
    account: mapAccount(row.account),
    roles: await getRoles(db, row.account.id),
    expiresAt: row.session.expiresAt,
  };
}

export async function deleteSessionByToken(
  db: Db,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
}

export async function saveTokenSet(
  db: Db,
  config: StoreConfig,
  accountId: string,
  issuerKey: string,
  tokens: TokenResponse,
): Promise<void> {
  const accessTokenCiphertext = encryptSecret(
    tokens.access_token,
    config.keyring,
  );
  const refreshTokenCiphertext = tokens.refresh_token
    ? encryptSecret(tokens.refresh_token, config.keyring)
    : null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  await db
    .insert(oauthTokenSets)
    .values({
      accountId,
      issuerKey,
      accessTokenCiphertext,
      refreshTokenCiphertext,
      tokenType: tokens.token_type,
      scope: tokens.scope ?? null,
      expiresAt,
      status: "active",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: oauthTokenSets.accountId,
      set: {
        accessTokenCiphertext,
        refreshTokenCiphertext,
        tokenType: tokens.token_type,
        scope: tokens.scope ?? null,
        expiresAt,
        status: "active",
        updatedAt: new Date(),
      },
    });
}

export async function loadTokenSet(
  db: Db,
  accountId: string,
): Promise<typeof oauthTokenSets.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(oauthTokenSets)
    .where(eq(oauthTokenSets.accountId, accountId))
    .limit(1);
  return row ?? null;
}

export async function refreshAccountTokens(
  db: Db,
  config: StoreConfig,
  accountId: string,
): Promise<{ expiresAt: Date | null }> {
  const row = await loadTokenSet(db, accountId);
  if (!row?.refreshTokenCiphertext) {
    throw new OAuthError("reauth_required");
  }

  const issuer = await loadActiveIssuer(db, config, row.issuerKey);
  const client = new SforumOAuthClient(issuer);
  const previousRefresh = decryptSecret(
    row.refreshTokenCiphertext,
    config.keyring,
  );

  try {
    const rotated = await client.refresh(previousRefresh);
    const tokens: TokenResponse = {
      ...rotated,
      refresh_token: rotated.refresh_token ?? previousRefresh,
    };
    await saveTokenSet(db, config, accountId, row.issuerKey, tokens);
    return {
      expiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
    };
  } catch (error) {
    await db
      .update(oauthTokenSets)
      .set({ status: "reauth_required", updatedAt: new Date() })
      .where(eq(oauthTokenSets.accountId, accountId));
    throw error;
  }
}

export async function revokeAccountTokens(
  db: Db,
  config: StoreConfig,
  accountId: string,
): Promise<void> {
  const row = await loadTokenSet(db, accountId);
  if (!row) return;

  try {
    const issuer = await loadActiveIssuer(db, config, row.issuerKey);
    const client = new SforumOAuthClient(issuer);
    if (row.refreshTokenCiphertext) {
      await client.revoke(
        decryptSecret(row.refreshTokenCiphertext, config.keyring),
        "refresh_token",
      );
    } else {
      await client.revoke(
        decryptSecret(row.accessTokenCiphertext, config.keyring),
        "access_token",
      );
    }
  } catch (error) {
    console.warn("[auth] revoke failed; deleting local token set", error);
  } finally {
    await db
      .delete(oauthTokenSets)
      .where(eq(oauthTokenSets.accountId, accountId));
  }
}

export async function completeLogin(input: {
  db: Db;
  config: StoreConfig;
  /** Resolved from the signed state cookie — a deployment may serve several forums. */
  issuerKey: string;
  code: string;
  verifier: string;
  redirectUri: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{
  account: SessionAccount;
  roles: ("admin" | "moderator")[];
  sessionToken: string;
  expiresAt: Date;
}> {
  const { db, config } = input;
  const issuer = await loadActiveIssuer(db, config, input.issuerKey);
  const client = new SforumOAuthClient(issuer);
  const tokens = await client.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
    verifier: input.verifier,
  });
  const user = await client.userinfo(tokens.access_token);

  const account = await upsertAccount(db, issuer.issuerKey, user);
  await db
    .update(oauthIssuers)
    .set({ lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(oauthIssuers.issuerKey, issuer.issuerKey));
  await saveTokenSet(db, config, account.id, issuer.issuerKey, tokens);
  const session = await createSession(db, account.id, {
    ttlSeconds: config.sessionTtlSeconds,
    userAgent: input.userAgent,
    ip: input.ip,
  });

  return {
    account: mapAccount(account),
    roles: await getRoles(db, account.id),
    sessionToken: session.token,
    expiresAt: session.expiresAt,
  };
}

import type { Db } from "@/db/client";
import { oauthIssuers } from "@/db/schema";
import type { StoreConfig } from "@/lib/config";
import { encryptSecret } from "@/lib/crypto";

export type IssuerFixture = {
  issuerKey: string;
  displayName: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

/**
 * Issuers are no longer bootstrapped from env (`STORE_BOOTSTRAP_ISSUER` is gone), so every
 * test that logs in has to seed the row itself — exactly like the admin console does.
 */
export async function seedIssuer(
  db: Db,
  config: StoreConfig,
  overrides: Partial<IssuerFixture> = {},
): Promise<IssuerFixture> {
  const fixture: IssuerFixture = {
    issuerKey: "official",
    displayName: "测试论坛",
    baseUrl: "http://127.0.0.1:4010",
    clientId: "store-client",
    clientSecret: "dev-secret",
    scopes: ["profile", "avatar"],
    ...overrides,
  };

  const ciphertext = encryptSecret(fixture.clientSecret, config.keyring);
  await db
    .insert(oauthIssuers)
    .values({
      issuerKey: fixture.issuerKey,
      displayName: fixture.displayName,
      baseUrl: fixture.baseUrl,
      clientId: fixture.clientId,
      clientSecretCiphertext: ciphertext,
      clientSecretKid: ciphertext.split(".")[1] ?? "unknown",
      scopes: fixture.scopes,
    })
    .onConflictDoNothing();

  return fixture;
}

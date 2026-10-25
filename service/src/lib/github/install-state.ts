import { signPayload, verifySignature } from "@/lib/crypto";

export type InstallState = {
  accountId: string;
  nonce: string;
  exp: number;
};

export function encodeInstallState(
  payload: InstallState,
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function decodeInstallState(
  value: string,
  secret: string,
): InstallState | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!verifySignature(encoded, signature, secret)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const input = payload as Record<string, unknown>;
  if (
    typeof input.accountId !== "string" ||
    typeof input.nonce !== "string" ||
    typeof input.exp !== "number" ||
    input.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return {
    accountId: input.accountId,
    nonce: input.nonce,
    exp: input.exp,
  };
}

/**
 * The setup redirect's state check.
 *
 * The cookie holds the signed token we sent to GitHub as `state`; the query must carry that
 * same token back. Comparing the decoded `nonce` against the query — the shape this started
 * with — can never match, because the query carries the whole signed token rather than the
 * nonce inside it. That bug made every install redirect answer `state_mismatch`, so the
 * installation was only ever recorded by the webhook.
 *
 * Both halves are required: the signature proves we minted the token, the equality proves the
 * redirect belongs to this browser's flow.
 */
export function verifyInstallState(
  cookieValue: string | null,
  queryState: string | null,
  secret: string,
): InstallState | null {
  if (!cookieValue || !queryState) return null;
  if (cookieValue !== queryState) return null;
  return decodeInstallState(cookieValue, secret);
}

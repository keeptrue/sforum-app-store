import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGithubSignature(
  payload: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  const actual = Buffer.from(signatureHeader, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return (
    actual.length === wanted.length && timingSafeEqual(actual, wanted)
  );
}

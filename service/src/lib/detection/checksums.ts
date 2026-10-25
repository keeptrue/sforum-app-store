import { createHash } from "node:crypto";

const LINE = /^([0-9a-f]{64})\s+\*?(.+)$/i;

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const digest = match[1].toLowerCase();
    const filename = match[2].trim().replace(/^\.\//, "");
    map.set(filename, digest);
    const base = filename.split("/").pop();
    if (base && !map.has(base)) map.set(base, digest);
  }
  return map;
}

export function checksumFor(
  map: Map<string, string>,
  filename: string,
): string | null {
  return map.get(filename) ?? map.get(filename.split("/").pop() ?? "") ?? null;
}

export function sha256Hex(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

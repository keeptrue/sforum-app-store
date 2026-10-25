#!/usr/bin/env bun
/**
 * Sync the vendored host capability catalog.
 *
 *   bun scripts/sync-capability-catalog.ts --sforum ~/Code/github/SForum
 *   bun scripts/sync-capability-catalog.ts --check
 *
 * The store never invents a capability label or a risk tier. `catalog.json` is a
 * field-for-field copy of the table the host generates from
 * `apps/api/app/Support/Capabilities/catalog.go` with
 * `go run ./cmd/sforum extension docs generate`, and the store's CI runs the host's
 * `--check` counterpart upstream, so the doc is already pinned to the Go catalog.
 *
 * Reading the generated markdown instead of the Go source is deliberate: a changed column
 * layout fails here loudly instead of silently shifting one field into another.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const targetDir = join(repoRoot, "service/src/lib/capabilities");
const catalogPath = join(targetDir, "catalog.json");
const lockPath = join(targetDir, "catalog.lock.json");

const UPSTREAM = "github.com/zhuchunshu/sforum";
const DOC_RELATIVE = "docs/extensions/catalogs/capabilities.md";
const EXPECTED_HEADER = ["Key", "Risk", "Label (EN)", "Label (ZH)", "Description"];
const RISK_VALUES = ["low", "medium", "high"] as const;
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/;

type Risk = (typeof RISK_VALUES)[number];

type CatalogEntry = {
  key: string;
  risk: Risk;
  labelZh: string;
  labelEn: string;
  description: string;
};

type CatalogLock = {
  upstream: string;
  source: string;
  commit: string;
  sha256: string;
  bytes: number;
  entries: number;
  docDirty: boolean;
  syncedAt: string;
};

function fail(message: string): never {
  console.error(`capability catalog: ${message}`);
  process.exit(1);
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Same shape as `manifest-v3.lock.json`: local time with an explicit offset. */
function localIso(date: Date): string {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}

function cells(line: string): string[] {
  // The host emits plain GFM rows: `| a | b | c | d | e |`. A stray pipe inside a cell is
  // not escaped by the generator, so a wrong cell count is a real layout change.
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Parse the generated markdown table into entries. Throws on any structural surprise. */
export function parseCatalogDoc(body: string): CatalogEntry[] {
  const lines = body.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    if (!line.startsWith("|")) return false;
    const row = cells(line);
    return row[0] === EXPECTED_HEADER[0] && row[1] === EXPECTED_HEADER[1];
  });
  if (headerIndex === -1) throw new Error("table header `| Key | Risk | ... |` not found");

  const header = cells(lines[headerIndex] ?? "");
  if (header.length !== EXPECTED_HEADER.length) {
    throw new Error(
      `header has ${header.length} columns, expected ${EXPECTED_HEADER.length}: ${header.join(" | ")}`,
    );
  }
  header.forEach((cell, index) => {
    if (cell !== EXPECTED_HEADER[index]) {
      throw new Error(`column ${index + 1} is "${cell}", expected "${EXPECTED_HEADER[index]}"`);
    }
  });

  const separator = lines[headerIndex + 1] ?? "";
  if (!/^\|(?:\s*-{3,}\s*\|)+$/.test(separator.trim())) {
    throw new Error("table separator row is missing or malformed");
  }

  const entries: CatalogEntry[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("|")) break;
    const row = cells(line);
    if (row.length !== EXPECTED_HEADER.length) {
      throw new Error(
        `row ${index + 1} has ${row.length} cells, expected ${EXPECTED_HEADER.length}: ${line.slice(0, 120)}`,
      );
    }
    const [rawKey, rawRisk, labelEn, labelZh, description] = row as [
      string,
      string,
      string,
      string,
      string,
    ];
    entries.push({
      key: rawKey.replace(/`/g, "").trim(),
      risk: rawRisk.trim() as Risk,
      labelZh: labelZh.trim(),
      labelEn: labelEn.trim(),
      description: description.trim(),
    });
  }

  if (entries.length === 0) throw new Error("table has no capability rows");
  return entries;
}

/** Problems with a parsed catalog, as human sentences. Shared by sync and check. */
function structureProblems(entries: CatalogEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const where = `row ${index + 1} (${entry.key || "empty key"})`;
    if (!KEY_PATTERN.test(entry.key)) problems.push(`${where}: key is not a dotted lower-case id`);
    if (seen.has(entry.key)) problems.push(`${where}: duplicate key`);
    seen.add(entry.key);
    if (!RISK_VALUES.includes(entry.risk)) {
      problems.push(`${where}: risk "${entry.risk}" is not one of ${RISK_VALUES.join("/")}`);
    }
    if (!entry.labelZh) problems.push(`${where}: Chinese label is empty`);
    if (!entry.labelEn) problems.push(`${where}: English label is empty`);
    if (!entry.description) problems.push(`${where}: description is empty`);
  });
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  entries.forEach((entry, index) => {
    if (entry.key !== sorted[index]?.key) {
      problems.push(`entry ${index + 1} is out of order: found "${entry.key}"`);
    }
  });
  return problems;
}

function git(sforumRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", sforumRoot, ...args], { encoding: "utf8" }).trim();
}

function renderCatalog(entries: CatalogEntry[]): string {
  const body = {
    entries: entries.map((entry) => ({
      key: entry.key,
      risk: entry.risk,
      labelZh: entry.labelZh,
      labelEn: entry.labelEn,
      description: entry.description,
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function sync(sforumRoot: string): void {
  const docPath = join(sforumRoot, DOC_RELATIVE);
  let doc: string;
  try {
    doc = readFileSync(docPath, "utf8");
  } catch {
    fail(`cannot read ${docPath}; pass --sforum <SForum checkout>`);
  }

  const entries = parseCatalogDoc(doc)
    .map((entry) => ({ ...entry, key: entry.key.trim() }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const problems = structureProblems(entries);
  if (problems.length > 0) fail(`the host table is not usable:\n  - ${problems.join("\n  - ")}`);

  let commit: string;
  try {
    commit = git(sforumRoot, ["rev-parse", "HEAD"]);
  } catch {
    fail(`${sforumRoot} is not a git checkout, so the catalog cannot be pinned to a commit`);
  }
  const docDirty = git(sforumRoot, ["status", "--porcelain", "--", DOC_RELATIVE]).length > 0;
  if (docDirty) {
    console.warn(
      `capability catalog: ${DOC_RELATIVE} has uncommitted changes; the lock records commit ${commit.slice(0, 7)} but the doc does not match it`,
    );
  }

  const body = renderCatalog(entries);
  const lock: CatalogLock = {
    upstream: UPSTREAM,
    source: DOC_RELATIVE,
    commit,
    sha256: sha256(body),
    bytes: Buffer.byteLength(body),
    entries: entries.length,
    docDirty,
    syncedAt: localIso(new Date()),
  };

  writeFileSync(catalogPath, body);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `capability catalog: wrote ${entries.length} entries from ${commit.slice(0, 7)} (sha256 ${lock.sha256.slice(0, 12)}…)`,
  );
}

function check(): void {
  let body: string;
  let lock: CatalogLock;
  try {
    body = readFileSync(catalogPath, "utf8");
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as CatalogLock;
  } catch {
    fail("catalog.json / catalog.lock.json are missing; run capabilities:sync");
  }

  const problems: string[] = [];
  if (!lock.upstream || !lock.source || !lock.commit) {
    problems.push("lock is missing upstream/source/commit provenance");
  }
  if (sha256(body) !== lock.sha256) {
    problems.push("catalog.json does not match the lock's sha256 (edited by hand?)");
  }
  if (Buffer.byteLength(body) !== lock.bytes) {
    problems.push("catalog.json byte length does not match the lock");
  }

  let entries: CatalogEntry[] = [];
  try {
    const parsed = JSON.parse(body) as { entries?: CatalogEntry[] };
    entries = parsed.entries ?? [];
  } catch {
    problems.push("catalog.json is not valid JSON");
  }
  if (entries.length !== lock.entries) {
    problems.push(`catalog.json has ${entries.length} entries, the lock records ${lock.entries}`);
  }
  problems.push(...structureProblems(entries));

  if (problems.length > 0) fail(`inconsistent vendored catalog:\n  - ${problems.join("\n  - ")}`);

  const dirtyNote = lock.docDirty ? " (synced from an uncommitted doc)" : "";
  console.log(
    `capability catalog: ${entries.length} entries, lock matches, upstream ${lock.commit.slice(0, 7)}${dirtyNote}`,
  );
}

const sforumRoot = readFlag("--sforum");
if (process.argv.includes("--check")) {
  check();
} else if (sforumRoot) {
  sync(resolve(sforumRoot));
} else {
  fail("pass --sforum <SForum checkout> to sync, or --check to verify");
}

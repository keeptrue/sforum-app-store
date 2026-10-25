#!/usr/bin/env bun
/**
 * Sync the vendored SForum manifest schema.
 *
 *   bun scripts/sync-manifest-schema.ts --sforum ~/Code/github/SForum
 *   bun scripts/sync-manifest-schema.ts --check
 *
 * The store never hand-edits `manifest-v3.schema.json`: it is a byte-for-byte copy of the
 * schema the host runs during install (`LoadRootBytes` -> `ValidateV3JSONSchema`). The lock
 * records where it came from so a review can tell drift from a local edit.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_RELATIVE =
  "apps/api/app/Support/ExtensionManifest/schemas/manifest-v3.schema.json";
const EXPECTED_ID = "https://sforum.dev/schemas/extensions/manifest-v3.schema.json";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const targetDir = join(repoRoot, "service/src/lib/detection/schema");
const schemaPath = join(targetDir, "manifest-v3.schema.json");
const lockPath = join(targetDir, "manifest-v3.lock.json");

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function fail(message: string): never {
  console.error(`manifest schema: ${message}`);
  process.exit(1);
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

function check(): void {
  const body = readFileSync(schemaPath);
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    sha256?: string;
    bytes?: number;
  };
  const digest = sha256(body);
  if (lock.sha256 !== digest) {
    fail(
      `vendored schema digest ${digest} does not match lock ${String(lock.sha256)}; ` +
        "re-run manifest:sync or revert the local edit",
    );
  }
  if (lock.bytes !== body.byteLength) {
    fail(`vendored schema is ${body.byteLength} bytes, lock says ${String(lock.bytes)}`);
  }
  console.log(`manifest schema OK: ${digest}`);
}

function sync(sforumRoot: string): void {
  const source = join(sforumRoot, SCHEMA_RELATIVE);
  let body: Buffer;
  try {
    body = readFileSync(source);
  } catch {
    fail(`cannot read ${source}`);
  }

  let parsed: { $id?: string };
  try {
    parsed = JSON.parse(body.toString("utf8")) as { $id?: string };
  } catch {
    fail(`${source} is not JSON`);
  }
  if (parsed.$id !== EXPECTED_ID) {
    fail(`unexpected $id ${String(parsed.$id)} in ${source}`);
  }

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", sforumRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // A source tarball has no git metadata; the digest still pins the bytes.
  }

  const digest = sha256(body);
  const previous = (() => {
    try {
      return JSON.parse(readFileSync(lockPath, "utf8")) as { sha256?: string };
    } catch {
      return null;
    }
  })();

  writeFileSync(schemaPath, body);
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        upstream: "github.com/zhuchunshu/sforum",
        source: SCHEMA_RELATIVE,
        commit,
        sha256: digest,
        bytes: body.byteLength,
        syncedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const changed = previous?.sha256 !== digest;
  console.log(
    changed
      ? `manifest schema updated: ${previous?.sha256 ?? "(none)"} -> ${digest} (${commit})`
      : `manifest schema unchanged: ${digest} (${commit})`,
  );
}

if (process.argv.includes("--check")) {
  check();
} else {
  const explicit = readFlag("--sforum");
  const root =
    explicit ??
    process.env.SFORUM_ROOT ??
    resolve(repoRoot, "../SForum");
  sync(resolve(root));
}

#!/usr/bin/env bun
/**
 * Conformance check for the manifest parser.
 *
 *   bun scripts/manifest-conformance.ts          # store parser only
 *   bun scripts/manifest-conformance.ts --host   # also run SForum's own validator
 *
 * The corpus in `test/fixtures/manifest` is the contract between the two implementations:
 * every case must get the same verdict from the store and from the host's
 * `validate-manifest` tool (which runs `ValidateV3JSONSchema` + `LoadPackage` + `Validate`).
 * `--host` needs a Go toolchain and the sibling SForum checkout the plugin module replaces.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ManifestError, parseManifest } from "../src/lib/detection/manifest";

type Case = { file: string; verdict: "accept" | "reject"; code?: string };

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../test/fixtures/manifest");
const backendDir = resolve(here, "../../plugin/plugins/sforum.store/backend");

const cases = (
  JSON.parse(readFileSync(join(fixturesDir, "cases.json"), "utf8")) as {
    cases: Case[];
  }
).cases;

const known = new Set(cases.map((item) => item.file));
const orphans = readdirSync(fixturesDir).filter(
  (name) => name.endsWith(".json") && name !== "cases.json" && !known.has(name),
);
if (orphans.length > 0) {
  console.error(`manifest conformance: fixtures missing from cases.json: ${orphans.join(", ")}`);
  process.exit(1);
}

function storeVerdict(file: string): { verdict: "accept" | "reject"; code?: string } {
  const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as unknown;
  try {
    parseManifest(input);
    return { verdict: "accept" };
  } catch (error) {
    if (error instanceof ManifestError) {
      return { verdict: "reject", code: error.code };
    }
    throw error;
  }
}

type Failure = { file: string; expected: string; actual: string };

const failures: Failure[] = [];

for (const item of cases) {
  const store = storeVerdict(item.file);
  if (store.verdict !== item.verdict) {
    failures.push({
      file: item.file,
      expected: `store ${item.verdict}`,
      actual: `store ${store.verdict}${store.code ? ` (${store.code})` : ""}`,
    });
    continue;
  }
  if (item.code && store.code !== item.code) {
    failures.push({
      file: item.file,
      expected: `store code ${item.code}`,
      actual: `store code ${store.code ?? "(none)"}`,
    });
  }
}

let hostRuns = 0;
if (process.argv.includes("--host")) {
  const go = spawnSync("go", ["version"], { encoding: "utf8" });
  if (go.error || go.status !== 0) {
    console.log("manifest conformance: go not available, skipping host comparison");
  } else {
    const buildDir = mkdtempSync(join(tmpdir(), "manifest-validator-"));
    const binary = join(buildDir, "validate-manifest");
    const build = spawnSync(
      "go",
      ["build", "-o", binary, "./cmd/validate-manifest"],
      { cwd: backendDir, encoding: "utf8" },
    );
    if (build.status !== 0) {
      console.error(
        `manifest conformance: building the host validator failed\n${build.stderr ?? ""}`,
      );
      process.exit(1);
    }

    try {
      for (const item of cases) {
        const dir = mkdtempSync(join(tmpdir(), "manifest-case-"));
        try {
          copyFileSync(
            join(fixturesDir, item.file),
            join(dir, "sforum.extension.json"),
          );
          const run = spawnSync(binary, [dir], { encoding: "utf8" });
          const hostVerdict = run.status === 0 ? "accept" : "reject";
          hostRuns += 1;
          if (hostVerdict !== item.verdict) {
            failures.push({
              file: item.file,
              expected: `host ${item.verdict}`,
              actual: `host ${hostVerdict}${run.stderr ? `: ${run.stderr.trim().split("\n")[0]}` : ""}`,
            });
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`${failure.file}: expected ${failure.expected}, got ${failure.actual}`);
  }
  console.error(`manifest conformance: ${failures.length} mismatch(es)`);
  process.exit(1);
}

console.log(
  `manifest conformance OK: ${cases.length} fixtures${hostRuns > 0 ? `, ${hostRuns} host runs` : ""}`,
);

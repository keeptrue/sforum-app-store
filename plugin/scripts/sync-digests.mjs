#!/usr/bin/env bun
// 重算包内所有被声明的摘要：packageFiles、backend.digest、openapi[].digest。
// 宿主按 exact-artifact 校验，任何字节变化都必须重新跑这一步。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..", "plugins", "sforum.store");
const manifestPath = join(root, "sforum.extension.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

let updated = 0;
const missing = [];

for (const file of manifest.packageFiles ?? []) {
  const abs = join(root, file.path);
  if (!existsSync(abs)) {
    missing.push(file.path);
    continue;
  }
  const digest = sha256(abs);
  if (file.digest !== digest) {
    file.digest = digest;
    updated += 1;
  }
}

if (manifest.backend?.entry) {
  const abs = join(root, manifest.backend.entry);
  if (existsSync(abs)) manifest.backend.digest = sha256(abs);
}

for (const fragment of manifest.openapi ?? []) {
  const abs = join(root, fragment.path);
  if (existsSync(abs)) {
    const digest = sha256(abs);
    if (fragment.digest !== digest) {
      fragment.digest = digest;
      updated += 1;
    }
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`digests: ${updated} updated, ${missing.length} missing`);
if (missing.length > 0) {
  console.error(`missing package files:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

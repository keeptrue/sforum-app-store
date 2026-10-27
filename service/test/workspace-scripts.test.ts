import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

/**
 * The root package delegates almost everything to the `service` workspace. A missing target
 * is not a build error: `bun run <script>` simply fails at the moment an operator needs it —
 * which is exactly how `bun run worker` stayed broken while the web app looked healthy.
 *
 * This suite pins the delegation contract and the `dev`/`start` wiring so a future script
 * rename cannot silently split the web and worker again.
 */

type PackageJson = { scripts?: Record<string, string> };

function readPackage(url: URL): PackageJson {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as PackageJson;
}

const root = readPackage(new URL("../../package.json", import.meta.url));
const service = readPackage(new URL("../package.json", import.meta.url));
const rootScripts = root.scripts ?? {};
const serviceScripts = service.scripts ?? {};

/** `bun run --filter service <target>` — including an `ENV=...` prefix. */
function filteredTarget(command: string): string | null {
  const match = /bun run --filter service (\S+)/.exec(command);
  return match?.[1] ?? null;
}

/** `cd service && bun run <target>` — the two direct delegations. */
function directTarget(command: string): string | null {
  const match = /^cd service && bun run (\S+)$/.exec(command);
  return match?.[1] ?? null;
}

describe("workspace script wiring", () => {
  test("every delegated root script exists in the service package", () => {
    const missing: string[] = [];

    for (const [name, command] of Object.entries(rootScripts)) {
      const target = filteredTarget(command) ?? directTarget(command);
      if (target === null) continue;
      if (serviceScripts[target] === undefined) {
        missing.push(`${name} -> service:${target}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test("dev and start run both halves through the supervisor", () => {
    for (const [name, halves] of [
      ["dev", ["dev:web", "worker"]],
      ["start", ["start:web", "worker:prod"]],
    ] as const) {
      expect(rootScripts[name]).toBe(`bun run scripts/supervise.ts ${halves.join(" ")}`);

      for (const half of halves) {
        const target = filteredTarget(rootScripts[half] ?? "");
        expect(target).not.toBeNull();
        expect(serviceScripts[target!]).toBeDefined();
      }
    }

    expect(rootScripts["dev:stop"]).toBe("bun run scripts/dev-stop.ts");
  });
});

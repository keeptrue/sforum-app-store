import { describe, expect, test } from "bun:test";

import { ManifestError, isStrictSemver, parseManifest } from "./manifest";

const base = {
  manifestVersion: 3,
  id: "sforum.demo",
  name: "Demo",
  description: "演示扩展。",
  url: "https://github.com/example/sforum-demo",
  author: { name: "SForum" },
  version: "1.2.3",
  type: "plugin",
  sforumVersion: ">=1.0.0 <2.0.0",
};

function codeOf(input: unknown): string {
  try {
    parseManifest(input);
  } catch (error) {
    if (error instanceof ManifestError) return error.code;
    throw error;
  }
  throw new Error("expected the manifest to be rejected");
}

describe("manifest schema gate", () => {
  test("accepts a complete plugin manifest", () => {
    const manifest = parseManifest({
      ...base,
      capabilities: ["settings.own", "host.api"],
      langs: { zh_cn: { name: "演示" } },
      packageFiles: [
        {
          id: "sforum.demo.file.backend",
          kind: "executable",
          path: "backend/plugin",
          digest: "a".repeat(64),
        },
      ],
    });
    expect(manifest.id).toBe("sforum.demo");
    // The host trims, dedupes and sorts capabilities (`NormalizeKeys`).
    expect(manifest.capabilities).toEqual(["host.api", "settings.own"]);
    expect(manifest.langs).toEqual({ "zh-CN": { name: "演示" } });
    expect(manifest.packageFiles).toEqual([
      { path: "backend/plugin", digest: "a".repeat(64) },
    ]);
  });

  test("accepts a theme without backend", () => {
    expect(parseManifest({ ...base, type: "theme" }).type).toBe("theme");
  });

  test("rejects unknown top-level fields, like the host schema", () => {
    expect(codeOf({ ...base, capabilties: ["host.api"] })).toBe(
      "manifest_schema_invalid",
    );
  });

  test("rejects a missing required field with a field-specific code", () => {
    const { description: _description, ...withoutDescription } = base;
    expect(codeOf(withoutDescription)).toBe("manifest_description_missing");
    const { url: _url, ...withoutUrl } = base;
    expect(codeOf(withoutUrl)).toBe("manifest_url_invalid");
    const { author: _author, ...withoutAuthor } = base;
    expect(codeOf(withoutAuthor)).toBe("manifest_author_invalid");
  });

  test("rejects capabilities that are not strings", () => {
    expect(codeOf({ ...base, capabilities: ["host.api", 1] })).toBe(
      "manifest_capabilities_invalid",
    );
  });

  test("accepts null capability arrays and normalizes them to empty", () => {
    expect(parseManifest({ ...base, capabilities: null }).capabilities).toEqual([]);
  });
});

describe("manifest identity rules", () => {
  test("accepts an 81-character id and rejects 82", () => {
    const id81 = `a${"b".repeat(80)}`;
    expect(parseManifest({ ...base, id: id81 }).id).toBe(id81);
    expect(codeOf({ ...base, id: `${id81}c` })).toBe("manifest_id_invalid");
  });

  test("rejects an uppercase id, like the host schema", () => {
    // The host validates the raw document against the schema before `Normalize`, so the
    // lowercase pattern is a hard requirement, not a normalization step.
    expect(codeOf({ ...base, id: "SForum.Demo" })).toBe("manifest_id_invalid");
  });

  test("rejects an uppercase type, like the host schema", () => {
    expect(codeOf({ ...base, type: "Plugin" })).toBe("manifest_type_invalid");
  });

  test("rejects duplicate capabilities, like the host schema", () => {
    expect(codeOf({ ...base, capabilities: ["host.api", "host.api"] })).toBe(
      "manifest_capabilities_invalid",
    );
  });

  test("rejects an unsupported manifestVersion", () => {
    expect(codeOf({ ...base, manifestVersion: 2 })).toBe(
      "manifest_version_unsupported",
    );
  });
});

describe("manifest versions", () => {
  test("accepts build metadata and rejects loose versions", () => {
    expect(parseManifest({ ...base, version: "1.2.3+build.5" }).version).toBe(
      "1.2.3+build.5",
    );
    for (const version of ["1.2", "v1.2.3", "01.2.3"]) {
      expect(codeOf({ ...base, version })).toBe("manifest_version_invalid");
      expect(isStrictSemver(version)).toBe(false);
    }
    expect(isStrictSemver("1.2.3-rc.1")).toBe(true);
  });

  test("requires a parsable sforumVersion constraint", () => {
    expect(codeOf({ ...base, sforumVersion: "not a range" })).toBe(
      "manifest_constraint_invalid",
    );
    // Masterminds `!=` is valid; node-semver alone would call this garbage.
    expect(
      parseManifest({ ...base, sforumVersion: ">=1.0.0, !=1.2.3" }).sforumVersion,
    ).toBe(">=1.0.0, !=1.2.3");
  });
});

describe("manifest backend rules", () => {
  const backend = {
    entry: "backend/plugin",
    rpc: "hashicorp-go-plugin",
    protocolVersion: 2,
    digest: "a".repeat(64),
    hostApiVersion: "sforum.host@2",
  };

  test("accepts a complete backend declaration", () => {
    expect(parseManifest({ ...base, backend }).backend).toEqual(backend);
  });

  test("rejects an incomplete backend declaration", () => {
    expect(codeOf({ ...base, backend: { entry: "backend/plugin" } })).toBe(
      "manifest_backend_incomplete",
    );
    expect(
      codeOf({ ...base, backend: { ...backend, protocolVersion: 1 } }),
    ).toBe("manifest_backend_incomplete");
    expect(codeOf({ ...base, backend: { ...backend, digest: "xyz" } })).toBe(
      "manifest_backend_incomplete",
    );
    expect(
      codeOf({ ...base, backend: { ...backend, hostApiVersion: "sforum.host" } }),
    ).toBe("manifest_backend_incomplete");
  });

  test("rejects an entry-less backend that carries other fields", () => {
    expect(
      codeOf({ ...base, backend: { entry: "", digest: "a".repeat(64) } }),
    ).toBe("manifest_backend_incomplete");
  });

  test("rejects an unsafe backend entry", () => {
    expect(
      codeOf({ ...base, backend: { ...backend, entry: "../plugin" } }),
    ).toBe("manifest_backend_entry_unsafe");
  });

  test("themes may not declare a backend", () => {
    expect(codeOf({ ...base, type: "theme", backend })).toBe(
      "theme_backend_not_allowed",
    );
  });
});

describe("manifest theme rules", () => {
  test("rejects plugin-only declarations on a theme", () => {
    expect(codeOf({ ...base, type: "theme", permissions: ["content.read"] })).toBe(
      "manifest_theme_declaration_invalid",
    );
    expect(codeOf({ ...base, type: "theme", capabilities: ["host.api"] })).toBe(
      "manifest_theme_declaration_invalid",
    );
  });

  test("allows the families the host allows on themes", () => {
    const manifest = parseManifest({
      ...base,
      type: "theme",
      components: [],
      templates: [],
      assets: [],
      settings: [],
    });
    expect(manifest.type).toBe("theme");
  });
});

describe("manifest metadata", () => {
  test("validates urls and author fields", () => {
    expect(codeOf({ ...base, url: "ftp://example.com" })).toBe(
      "manifest_url_invalid",
    );
    expect(
      codeOf({ ...base, author: { name: "SForum", url: "not-a-url" } }),
    ).toBe("manifest_author_invalid");
    expect(
      codeOf({ ...base, author: { name: "SForum", email: "nope" } }),
    ).toBe("manifest_author_invalid");
  });

  test("requires requiresFeatures to use the features.* namespace", () => {
    expect(
      parseManifest({ ...base, requiresFeatures: ["features.search"] })
        .requiresFeatures,
    ).toEqual(["features.search"]);
    expect(codeOf({ ...base, requiresFeatures: ["search"] })).toBe(
      "manifest_requires_features_invalid",
    );
  });

  test("normalizes langs and drops empty overrides", () => {
    const manifest = parseManifest({
      ...base,
      langs: {
        zh_cn: { name: "演示", description: "演示扩展。" },
        "en-US": { name: "" },
      },
    });
    expect(manifest.langs).toEqual({
      "zh-CN": { name: "演示", description: "演示扩展。" },
    });
  });
});

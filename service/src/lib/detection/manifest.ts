import { parseConstraint } from "@/lib/semver-constraint";

import { ManifestSchemaError, assertManifestSchema } from "./schema";
import { isStrictSemver } from "./semver";

export { isStrictSemver };

export class ManifestError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ManifestError";
    this.code = code;
  }
}

export type ManifestAuthor = {
  name: string;
  url?: string;
  email?: string;
};

/** A `langs` override; every field is optional and empty fields do not override. */
export type ManifestLocale = {
  name?: string;
  description?: string;
  url?: string;
  author?: ManifestAuthor;
};

export type ManifestBackend = {
  entry: string;
  rpc: string;
  protocolVersion: number;
  digest: string;
  hostApiVersion: string;
};

export type ManifestPackageFile = {
  path: string;
  digest: string;
};

/**
 * The subset of `sforum.extension.json` the store reads, after the host's own schema gate
 * and normalization. Fields the store does not display are still validated here so a
 * version cannot be published when the host would refuse to install it.
 */
export type ExtensionManifest = {
  id: string;
  name: string;
  description: string;
  url: string;
  author: ManifestAuthor;
  version: string;
  type: "plugin" | "theme";
  sforumVersion: string;
  capabilities: string[];
  permissions: string[];
  requiresFeatures: string[];
  langs: Record<string, ManifestLocale>;
  backend?: ManifestBackend;
  packageFiles: ManifestPackageFile[];
};

/** Host `manifestIDPattern` (`manifest.go`), 81 characters total. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,80}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTRACT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/;
/** `net/mail` accepts `a@b`; stay at least that permissive. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/**
 * `isThemeManifestSupported` (`manifest.go`) forbids exactly these families on themes.
 * `components`/`templates`/`assets`/`adminPages`/`navigation`/`regions`/`settings` are
 * allowed, so this list must not be widened "for safety": over-rejecting hides valid themes.
 */
const THEME_FORBIDDEN_ARRAYS = [
  "permissions",
  "capabilities",
  "migrations",
  "routes",
  "hooks",
  "events",
  "jobs",
  "providers",
  "contributions",
  "guards",
  "schedules",
  "content",
  "editor",
  "entities",
  "cache",
  "seo",
  "services",
  "commands",
  "adminSurfaces",
  "queries",
  "queryResultFilters",
  "permissionDefinitions",
  "media",
  "openapi",
] as const;
const THEME_FORBIDDEN_OBJECTS = ["database", "identity", "lifecycle"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readStrings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/** Host `normalizeLocaleKey`: `zh_cn` -> `zh-CN`, `EN` -> `en`. */
export function normalizeLocaleKey(value: string): string {
  const trimmed = value.trim().replace(/_/g, "-");
  if (!trimmed) return "";
  const parts = trimmed.split("-");
  if (!parts[0]) return "";
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      return part.length === 2 ? part.toUpperCase() : part.toLowerCase();
    })
    .join("-");
}

function normalizeLangs(raw: unknown): Record<string, ManifestLocale> {
  if (!isRecord(raw)) return {};
  const normalized: Record<string, ManifestLocale> = {};
  for (const [key, value] of Object.entries(raw)) {
    const code = normalizeLocaleKey(key);
    if (!code || !isRecord(value)) continue;
    const name = readString(value, "name");
    const description = readString(value, "description");
    const url = readString(value, "url");
    const authorRaw = value.author;
    const author: ManifestAuthor | undefined = isRecord(authorRaw)
      ? {
          name: readString(authorRaw, "name"),
          ...(readString(authorRaw, "url") ? { url: readString(authorRaw, "url") } : {}),
          ...(readString(authorRaw, "email") ? { email: readString(authorRaw, "email") } : {}),
        }
      : undefined;
    const hasAuthor =
      author !== undefined &&
      Boolean(author.name || author.url || author.email);
    // An all-empty override carries no meaning; the host drops it too.
    if (!name && !description && !url && !hasAuthor) continue;
    normalized[code] = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      ...(hasAuthor ? { author } : {}),
    };
  }
  return normalized;
}

function assertLangs(langs: Record<string, ManifestLocale>): void {
  for (const [code, locale] of Object.entries(langs)) {
    if (!code) throw new ManifestError("manifest_schema_invalid", "langs: empty locale key");
    if (locale.url && !validHttpUrl(locale.url)) {
      throw new ManifestError("manifest_schema_invalid", `langs.${code}.url`);
    }
    if (locale.author?.url && !validHttpUrl(locale.author.url)) {
      throw new ManifestError("manifest_schema_invalid", `langs.${code}.author.url`);
    }
    if (locale.author?.email && !EMAIL_PATTERN.test(locale.author.email)) {
      throw new ManifestError("manifest_schema_invalid", `langs.${code}.author.email`);
    }
  }
}

function normalizeBackend(
  raw: Record<string, unknown>,
): ManifestBackend | undefined {
  const value = raw.backend;
  if (!isRecord(value)) return undefined;

  const entry = readString(value, "entry");
  const rpc = readString(value, "rpc");
  const hostApiVersion = readString(value, "hostApiVersion");
  const digest = readString(value, "digest");
  const protocolVersion =
    typeof value.protocolVersion === "number" ? value.protocolVersion : 0;

  if (!entry) {
    // Host rule #1: an entry-less backend may not carry any other field.
    if (rpc || hostApiVersion || digest || protocolVersion !== 0) {
      throw new ManifestError(
        "manifest_backend_incomplete",
        "backend without entry must not declare rpc/protocolVersion/digest/hostApiVersion",
      );
    }
    return undefined;
  }

  if (!isSafeRelativePath(entry)) {
    throw new ManifestError("manifest_backend_entry_unsafe", entry);
  }
  if (rpc !== "hashicorp-go-plugin") {
    throw new ManifestError("manifest_backend_incomplete", `backend.rpc=${rpc || "(empty)"}`);
  }
  if (protocolVersion !== 2) {
    throw new ManifestError(
      "manifest_backend_incomplete",
      `backend.protocolVersion=${String(protocolVersion)}`,
    );
  }
  if (!DIGEST_PATTERN.test(digest)) {
    throw new ManifestError("manifest_backend_incomplete", "backend.digest");
  }
  if (!CONTRACT_VERSION_PATTERN.test(hostApiVersion)) {
    throw new ManifestError("manifest_backend_incomplete", "backend.hostApiVersion");
  }

  return { entry, rpc, protocolVersion, digest, hostApiVersion };
}

function readPackageFiles(raw: Record<string, unknown>): ManifestPackageFile[] {
  const value = raw.packageFiles;
  if (!Array.isArray(value)) return [];
  const files: ManifestPackageFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = readString(item, "path");
    const digest = readString(item, "digest");
    if (!isSafeRelativePath(path)) {
      throw new ManifestError("manifest_schema_invalid", `packageFiles.path=${path}`);
    }
    if (!DIGEST_PATTERN.test(digest)) {
      throw new ManifestError("manifest_schema_invalid", `packageFiles.digest=${digest}`);
    }
    files.push({ path, digest });
  }
  return files;
}

function assertThemeDeclarations(
  raw: Record<string, unknown>,
  type: "plugin" | "theme",
  backend: ManifestBackend | undefined,
): void {
  if (type !== "theme") return;
  if (backend) {
    throw new ManifestError("theme_backend_not_allowed", backend.entry);
  }
  for (const key of THEME_FORBIDDEN_ARRAYS) {
    if (Array.isArray(raw[key]) && (raw[key] as unknown[]).length > 0) {
      throw new ManifestError("manifest_theme_declaration_invalid", key);
    }
  }
  for (const key of THEME_FORBIDDEN_OBJECTS) {
    if (isRecord(raw[key]) || Array.isArray(raw[key])) {
      throw new ManifestError("manifest_theme_declaration_invalid", key);
    }
  }
}

function toManifestError(error: ManifestSchemaError): ManifestError {
  const { path, keyword, message, missingProperty } = error.issue;
  const detail = `${path || "/"} ${message}`;

  if (keyword === "required") {
    switch (missingProperty) {
      case "manifestVersion":
        return new ManifestError("manifest_version_unsupported", detail);
      case "id":
        return new ManifestError("manifest_id_invalid", detail);
      case "name":
        return new ManifestError("manifest_name_missing", detail);
      case "description":
        return new ManifestError("manifest_description_missing", detail);
      case "url":
        return new ManifestError("manifest_url_invalid", detail);
      case "author":
        return new ManifestError("manifest_author_invalid", detail);
      case "version":
        return new ManifestError("manifest_version_invalid", detail);
      case "type":
        return new ManifestError("manifest_type_invalid", detail);
      case "sforumVersion":
        return new ManifestError("manifest_sforum_version_missing", detail);
      default:
        return new ManifestError("manifest_schema_invalid", detail);
    }
  }

  if (path === "/manifestVersion") {
    return new ManifestError("manifest_version_unsupported", detail);
  }
  if (path === "/id") return new ManifestError("manifest_id_invalid", detail);
  if (path === "/name") return new ManifestError("manifest_name_missing", detail);
  if (path === "/description") {
    return new ManifestError("manifest_description_missing", detail);
  }
  if (path === "/url") return new ManifestError("manifest_url_invalid", detail);
  if (path === "/author" || path.startsWith("/author/")) {
    return new ManifestError("manifest_author_invalid", detail);
  }
  if (path === "/version") return new ManifestError("manifest_version_invalid", detail);
  if (path === "/type") return new ManifestError("manifest_type_invalid", detail);
  if (path === "/sforumVersion") {
    return new ManifestError("manifest_sforum_version_missing", detail);
  }
  if (path === "/capabilities" || path.startsWith("/capabilities/")) {
    return new ManifestError("manifest_capabilities_invalid", detail);
  }
  if (path === "/backend" || path.startsWith("/backend/")) {
    return new ManifestError("manifest_backend_incomplete", detail);
  }
  return new ManifestError("manifest_schema_invalid", detail);
}

export function parseManifest(input: unknown): ExtensionManifest {
  if (!isRecord(input)) {
    throw new ManifestError("manifest_not_object");
  }
  if (input.manifestVersion !== 3) {
    throw new ManifestError("manifest_version_unsupported");
  }

  // The host runs this same schema before any semantic check (`LoadRootBytes`).
  try {
    assertManifestSchema(input);
  } catch (error) {
    if (error instanceof ManifestSchemaError) throw toManifestError(error);
    throw error;
  }

  const id = readString(input, "id").toLowerCase();
  if (!ID_PATTERN.test(id)) {
    throw new ManifestError("manifest_id_invalid", id);
  }

  const name = readString(input, "name");
  if (!name) throw new ManifestError("manifest_name_missing");

  const description = readString(input, "description");
  if (!description) throw new ManifestError("manifest_description_missing");

  const url = readString(input, "url");
  if (!validHttpUrl(url)) throw new ManifestError("manifest_url_invalid", url);

  const authorRaw = input.author;
  if (!isRecord(authorRaw)) throw new ManifestError("manifest_author_invalid");
  const authorName = readString(authorRaw, "name");
  if (!authorName) throw new ManifestError("manifest_author_invalid", "author.name");
  const authorUrl = readString(authorRaw, "url");
  if (authorUrl && !validHttpUrl(authorUrl)) {
    throw new ManifestError("manifest_author_invalid", authorUrl);
  }
  const authorEmail = readString(authorRaw, "email");
  if (authorEmail && !EMAIL_PATTERN.test(authorEmail)) {
    throw new ManifestError("manifest_author_invalid", authorEmail);
  }

  const version = readString(input, "version");
  if (!isStrictSemver(version)) {
    throw new ManifestError("manifest_version_invalid", version);
  }

  const typeValue = readString(input, "type").toLowerCase();
  if (typeValue !== "plugin" && typeValue !== "theme") {
    throw new ManifestError("manifest_type_invalid", typeValue);
  }
  const type = typeValue;

  const sforumVersion = readString(input, "sforumVersion");
  if (!sforumVersion) {
    throw new ManifestError("manifest_sforum_version_missing");
  }
  if (parseConstraint(sforumVersion) === null) {
    throw new ManifestError("manifest_constraint_invalid", sforumVersion);
  }

  const capabilities = [...new Set(readStrings(input, "capabilities"))].sort();
  const permissions = [...new Set(readStrings(input, "permissions"))];

  const requiresFeatures = [...new Set(readStrings(input, "requiresFeatures"))];
  for (const feature of requiresFeatures) {
    if (!feature.startsWith("features.") || feature.includes(" ")) {
      throw new ManifestError("manifest_requires_features_invalid", feature);
    }
  }

  const langs = normalizeLangs(input.langs);
  assertLangs(langs);

  const backend = normalizeBackend(input);
  assertThemeDeclarations(input, type, backend);

  const packageFiles = readPackageFiles(input);

  return {
    id,
    name,
    description,
    url,
    author: {
      name: authorName,
      ...(authorUrl ? { url: authorUrl } : {}),
      ...(authorEmail ? { email: authorEmail } : {}),
    },
    version,
    type,
    sforumVersion,
    capabilities,
    permissions,
    requiresFeatures,
    langs,
    ...(backend ? { backend } : {}),
    packageFiles,
  };
}

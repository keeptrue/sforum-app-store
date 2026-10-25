import { createHash } from "node:crypto";

import { openPromise, type Entry, type ZipFile } from "yauzl";

import { ManifestError, parseManifest, type ExtensionManifest } from "./manifest";

/**
 * Archive limits mirror the host install path (`apps/api/app/Models/Extensions/service.go`):
 * 4096 central-directory entries and 50 MiB of decompressed bytes. A package the store
 * accepts must be one `ReadArchive` accepts.
 */
export const MAX_ZIP_ENTRIES = 4096;
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_NAME = "sforum.extension.json";

export class ZipDetectionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ZipDetectionError";
    this.code = code;
  }
}

export type ExtensionZip = {
  manifest: ExtensionManifest;
  backend?: Buffer;
  entryCount: number;
};

function normalizeName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Host `ReadArchive` rejects any entry name containing `..`, a leading `/`, a NUL byte or
 * a Windows drive prefix. Matching that exactly is the point: a looser store rule would
 * publish packages the host refuses to unpack.
 */
function assertSafeName(name: string): void {
  const windowsDrive = name.length >= 2 && name[1] === ":" && /[A-Za-z]/.test(name[0]!);
  if (
    name.length === 0 ||
    name.includes("\u0000") ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    windowsDrive
  ) {
    throw new ZipDetectionError("zip_unsafe_path", name);
  }
}

function isSymlink(entry: Entry): boolean {
  // Unix mode lives in the high 16 bits of the external attributes.
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

async function readEntry(
  zip: ZipFile,
  entry: Entry,
  limit: number,
): Promise<Buffer> {
  if (entry.uncompressedSize > limit) {
    throw new ZipDetectionError("zip_entry_too_large", entry.fileName);
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new ZipDetectionError("zip_entry_too_large", entry.fileName);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function readExtensionZip(path: string): Promise<ExtensionZip> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });

  try {
    const entries: Entry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let nestedManifest: string | null = null;

    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      const name = normalizeName(entry.fileName);
      assertSafeName(name);
      if (isSymlink(entry)) {
        throw new ZipDetectionError("zip_symlink_entry", name);
      }
      if (seen.has(name)) {
        throw new ZipDetectionError("zip_duplicate_entry", name);
      }
      seen.add(name);
      if (name !== MANIFEST_NAME && name.endsWith(`/${MANIFEST_NAME}`)) {
        nestedManifest = name;
      }
      entries.push(entry);
      total += entry.uncompressedSize;
      if (entries.length > MAX_ZIP_ENTRIES) {
        throw new ZipDetectionError("zip_too_many_entries");
      }
      if (total > MAX_ZIP_BYTES) {
        throw new ZipDetectionError("zip_uncompressed_too_large");
      }
    }

    // The host reads the manifest from the package root only (`ReadArchive`). A nested
    // copy is ignored by the host, so it is ignored here too — but a package whose *only*
    // manifest sits in a subdirectory is one the host will never install.
    const manifestEntry = entries.find(
      (entry) => normalizeName(entry.fileName) === MANIFEST_NAME,
    );
    if (!manifestEntry) {
      if (nestedManifest !== null) {
        throw new ZipDetectionError("manifest_not_at_root", nestedManifest);
      }
      throw new ZipDetectionError("manifest_missing");
    }

    const manifestRaw = await readEntry(zip, manifestEntry, MAX_MANIFEST_BYTES);

    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw.toString("utf8"));
    } catch {
      throw new ManifestError("manifest_json_invalid");
    }
    const manifest = parseManifest(manifestJson);

    // `packageFiles` declares exact bytes; the host verifies every digest before install
    // (`ValidatePackageFiles`). Checking here keeps a broken package out of the catalog.
    for (const file of manifest.packageFiles) {
      const entry = entries.find(
        (candidate) => normalizeName(candidate.fileName) === file.path,
      );
      if (!entry) {
        throw new ZipDetectionError("package_file_missing", file.path);
      }
      const body = await readEntry(zip, entry, MAX_ZIP_BYTES);
      if (sha256(body) !== file.digest) {
        throw new ZipDetectionError("package_file_digest_mismatch", file.path);
      }
    }

    let backend: Buffer | undefined;
    if (manifest.backend) {
      const target = manifest.backend.entry;
      const backendEntry = entries.find(
        (entry) => normalizeName(entry.fileName) === target,
      );
      if (!backendEntry) {
        throw new ZipDetectionError("backend_entry_missing", target);
      }
      backend = await readEntry(zip, backendEntry, MAX_ZIP_BYTES);
    }

    return { manifest, backend, entryCount: entries.length };
  } finally {
    zip.close();
  }
}

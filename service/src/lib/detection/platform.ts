import type { ExtensionManifest } from "./manifest";

export type Platform = {
  os: string;
  arch: string;
  source: "buildinfo" | "header" | "filename" | "manifest";
};

const BUILDINFO_MAGIC = Buffer.from([
  0xff, 0x20, 0x47, 0x6f, 0x20, 0x62, 0x75, 0x69, 0x6c, 0x64, 0x69, 0x6e,
  0x66, 0x3a,
]);

function normalizeArch(value: string): string {
  switch (value.toLowerCase()) {
    case "x86_64":
    case "x64":
      return "amd64";
    case "aarch64":
      return "arm64";
    default:
      return value.toLowerCase();
  }
}

function fromBuildInfo(backend: Buffer): Platform | null {
  const index = backend.indexOf(BUILDINFO_MAGIC);
  if (index < 0) return null;
  const slice = backend.subarray(index, Math.min(backend.length, index + 1024 * 1024));
  const text = slice.toString("latin1");
  const goos = /\bGOOS=([a-z0-9]+)/.exec(text)?.[1];
  const goarch = /\bGOARCH=([a-z0-9]+)/.exec(text)?.[1];
  if (!goos || !goarch) return null;
  return { os: goos, arch: normalizeArch(goarch), source: "buildinfo" };
}

function fromHeader(backend: Buffer): Platform | null {
  if (
    backend.length >= 20 &&
    backend[0] === 0x7f &&
    backend[1] === 0x45 &&
    backend[2] === 0x4c &&
    backend[3] === 0x46
  ) {
    const machine = backend.readUInt16LE(18);
    const arch =
      machine === 0x3e
        ? "amd64"
        : machine === 0xb7
          ? "arm64"
          : machine === 0x03
            ? "386"
            : machine === 0x28
              ? "arm"
              : null;
    return arch ? { os: "linux", arch, source: "header" } : null;
  }

  if (backend.length >= 8) {
    const magic = backend.readUInt32BE(0);
    if (magic === 0xfeedface || magic === 0xfeedfacf) {
      const cpu = backend.readUInt32BE(4);
      const arch =
        cpu === 0x01000007
          ? "amd64"
          : cpu === 0x0100000c
            ? "arm64"
            : cpu === 0x00000007
              ? "386"
              : null;
      return arch ? { os: "darwin", arch, source: "header" } : null;
    }
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
      const cpu = backend.readUInt32LE(4);
      const arch =
        cpu === 0x01000007
          ? "amd64"
          : cpu === 0x0100000c
            ? "arm64"
            : null;
      return arch ? { os: "darwin", arch, source: "header" } : null;
    }
  }

  return null;
}

function fromFilename(filename: string): Platform | null {
  const match =
    /(linux|darwin|windows|freebsd|openbsd|netbsd)[-_](amd64|arm64|x86_64|aarch64|386|armv7|arm)/i.exec(
      filename,
    );
  if (!match) return null;
  return {
    os: match[1].toLowerCase(),
    arch: normalizeArch(match[2]),
    source: "filename",
  };
}

export function detectPlatform(input: {
  manifest: ExtensionManifest;
  backend?: Buffer;
  filename: string;
}): Platform | null {
  if (input.manifest.type === "theme" || !input.manifest.backend) {
    return { os: "any", arch: "any", source: "manifest" };
  }
  if (input.backend) {
    return (
      fromBuildInfo(input.backend) ??
      fromHeader(input.backend) ??
      fromFilename(input.filename)
    );
  }
  return fromFilename(input.filename);
}

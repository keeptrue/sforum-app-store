import { describe, expect, test } from "bun:test";

import { elfHeader } from "../../../test/zip-fixture";
import { detectPlatform } from "./platform";
import type { ExtensionManifest } from "./manifest";

const theme: ExtensionManifest = {
  id: "sforum.theme",
  name: "Theme",
  description: "Theme",
  url: "https://example.com/theme",
  author: { name: "SForum" },
  version: "1.0.0",
  type: "theme",
  sforumVersion: "*",
  capabilities: [],
  permissions: [],
  requiresFeatures: [],
  langs: {},
  packageFiles: [],
};

const plugin: ExtensionManifest = {
  id: "sforum.plugin",
  name: "Plugin",
  description: "Plugin",
  url: "https://example.com/plugin",
  author: { name: "SForum" },
  version: "1.0.0",
  type: "plugin",
  sforumVersion: "*",
  capabilities: [],
  permissions: [],
  requiresFeatures: [],
  langs: {},
  backend: {
    entry: "backend/plugin",
    rpc: "hashicorp-go-plugin",
    protocolVersion: 2,
    digest: "0".repeat(64),
    hostApiVersion: "sforum.host@2",
  },
  packageFiles: [],
};

describe("platform detection", () => {
  test("themes are any/any", () => {
    expect(detectPlatform({ manifest: theme, filename: "theme.zip" })).toEqual({
      os: "any",
      arch: "any",
      source: "manifest",
    });
  });

  test("reads Go buildinfo settings", () => {
    const backend = Buffer.concat([
      Buffer.from([0xff, 0x20]),
      Buffer.from("Go buildinf:"),
      Buffer.from("\nGOOS=linux\nGOARCH=arm64\n"),
    ]);
    expect(
      detectPlatform({ manifest: plugin, backend, filename: "plugin.zip" }),
    ).toEqual({ os: "linux", arch: "arm64", source: "buildinfo" });
  });

  test("reads an ELF header when buildinfo is absent", () => {
    expect(
      detectPlatform({
        manifest: plugin,
        backend: elfHeader(0x3e),
        filename: "plugin.zip",
      }),
    ).toEqual({ os: "linux", arch: "amd64", source: "header" });
  });

  test("falls back to the filename", () => {
    expect(
      detectPlatform({
        manifest: plugin,
        backend: Buffer.from("not a known binary"),
        filename: "plugin-windows-amd64.zip",
      }),
    ).toEqual({ os: "windows", arch: "amd64", source: "filename" });
  });

  test("returns null when nothing matches", () => {
    expect(
      detectPlatform({
        manifest: plugin,
        backend: Buffer.from("unknown"),
        filename: "plugin.zip",
      }),
    ).toBeNull();
  });
});

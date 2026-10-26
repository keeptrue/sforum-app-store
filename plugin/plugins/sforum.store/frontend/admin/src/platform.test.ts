// 架构可用性的纯函数测试：没有 DOM、没有 bridge，每条分支都能直接断言。
//
// 这里最重要的三条事实：`any/any` 是通配、空平台列表是「未知」而不是「不支持」、
// 没有 target 时不做判决（D8 未知即放行）。

import { describe, expect, test } from "bun:test";

import { createCopy } from "./copy";
import { toReleaseView } from "./logic";
import {
  isAnyPlatform,
  platformId,
  preferredRelease,
  releaseSupportsTarget,
  samePlatform,
  supportsTarget,
} from "./platform";
import type { AssetDto, PlatformDto, ReleaseDto } from "./types";

const ZH = createCopy("zh-CN");
const LINUX: PlatformDto = { os: "linux", arch: "amd64" };
const MAC: PlatformDto = { os: "darwin", arch: "arm64" };
const ANY: PlatformDto = { os: "any", arch: "any" };

function asset(platform: PlatformDto): AssetDto {
  return {
    os: platform.os,
    arch: platform.arch,
    filename: "demo.zip",
    size: 1024,
    sha256: "ab",
  };
}

function release(version: string, platforms: PlatformDto[], status = "published"): ReleaseDto {
  return {
    version,
    channel: "stable",
    publishedAt: "2026-10-20T08:00:00Z",
    sforumVersion: ">=1.0.0",
    status,
    assets: platforms.map(asset),
  };
}

function view(version: string, platforms: PlatformDto[], status = "published") {
  return toReleaseView(release(version, platforms, status), ZH, LINUX);
}

describe("supportsTarget", () => {
  test("an exact match is supported", () => {
    expect(supportsTarget([LINUX, MAC], LINUX)).toBe(true);
  });

  test("any/any runs anywhere", () => {
    expect(supportsTarget([ANY], LINUX)).toBe(true);
    expect(supportsTarget([MAC, ANY], LINUX)).toBe(true);
  });

  test("another architecture is not supported", () => {
    expect(supportsTarget([MAC], LINUX)).toBe(false);
    expect(supportsTarget([{ os: "linux", arch: "arm64" }], LINUX)).toBe(false);
  });

  test("no platform information is unknown, not unsupported", () => {
    expect(supportsTarget([], LINUX)).toBeNull();
    expect(supportsTarget(undefined, LINUX)).toBeNull();
    expect(supportsTarget(null, LINUX)).toBeNull();
  });

  test("no target means no verdict at all", () => {
    expect(supportsTarget([LINUX], null)).toBeNull();
    expect(supportsTarget([LINUX], undefined)).toBeNull();
    // 半截 target（缺 os 或 arch）同样没有基准。
    expect(supportsTarget([LINUX], { os: "", arch: "amd64" })).toBeNull();
    expect(supportsTarget([LINUX], { os: "linux", arch: "" })).toBeNull();
  });

  test("the two small helpers agree with the verdict", () => {
    expect(isAnyPlatform(ANY)).toBe(true);
    expect(isAnyPlatform(LINUX)).toBe(false);
    expect(samePlatform(LINUX, { os: "linux", arch: "amd64" })).toBe(true);
    expect(samePlatform(LINUX, MAC)).toBe(false);
    expect(platformId(LINUX)).toBe("linux/amd64");
  });
});

describe("releaseSupportsTarget", () => {
  test("reads the release assets through the view model", () => {
    expect(releaseSupportsTarget(view("1.0.0", [MAC]), LINUX)).toBe(false);
    expect(releaseSupportsTarget(view("1.0.0", [MAC, LINUX]), LINUX)).toBe(true);
    expect(releaseSupportsTarget(view("1.0.0", [ANY]), LINUX)).toBe(true);
  });

  test("a release without assets and a missing release are both unknown", () => {
    expect(releaseSupportsTarget(view("1.0.0", []), LINUX)).toBeNull();
    expect(releaseSupportsTarget(null, LINUX)).toBeNull();
  });

  test("the view model carries the same verdict it was built with", () => {
    expect(view("1.0.0", [MAC]).supported).toBe(false);
    expect(view("1.0.0", [LINUX]).supported).toBe(true);
    expect(toReleaseView(release("1.0.0", [MAC]), ZH).supported).toBeNull();
  });
});

describe("preferredRelease", () => {
  test("prefers the latest version when it is installable and supported", () => {
    const releases = [view("1.2.0", [LINUX]), view("1.3.0", [LINUX])];
    expect(preferredRelease(releases, LINUX, "1.3.0")?.version).toBe("1.3.0");
  });

  test("falls to the newest supported release when the latest is another architecture", () => {
    const releases = [view("1.2.0", [LINUX]), view("1.3.0", [MAC])];
    expect(preferredRelease(releases, LINUX, "1.3.0")?.version).toBe("1.2.0");
  });

  test("returns null when nothing supports this architecture", () => {
    const releases = [view("1.2.0", [MAC]), view("1.3.0", [MAC])];
    expect(preferredRelease(releases, LINUX, "1.3.0")).toBeNull();
  });

  test("an unknown target keeps the store's latest-version answer", () => {
    const releases = [view("1.2.0", [LINUX]), view("1.3.0", [MAC])];
    expect(preferredRelease(releases, null, "1.3.0")?.version).toBe("1.3.0");
  });

  test("unpublished or assetless releases never win", () => {
    const releases = [
      view("1.2.0", [LINUX]),
      view("1.3.0", [LINUX], "yanked"),
      view("1.4.0", []),
    ];
    expect(preferredRelease(releases, LINUX, "1.4.0")?.version).toBe("1.2.0");
  });

  test("no releases at all is null, not a crash", () => {
    expect(preferredRelease([], LINUX)).toBeNull();
  });
});

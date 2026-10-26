// Pure tests for the install bar decision and the author strip.
//
// The DOM half (footer buttons, notes injection) lives in `catalog.test.ts`; keeping the
// decision pure means each branch can be asserted without a bridge, a fetch or a click.

import { describe, expect, test } from "bun:test";

import { createCopy } from "./copy";
import {
  authorView,
  defaultPlatform,
  installFailurePhase,
  installFailureText,
  installGate,
  installGateText,
  relationLabel,
  toProductView,
  toReleaseView,
} from "./logic";
import type { PlatformDto, ProductDto, ReleaseDto, ReleaseView } from "./types";

const ZH = createCopy("zh-CN");
const EN = createCopy("en-US");

const LINUX: PlatformDto = { os: "linux", arch: "amd64" };
const MAC: PlatformDto = { os: "darwin", arch: "arm64" };
const ANY_PLATFORM: PlatformDto = { os: "any", arch: "any" };

function release(version: string, relation?: ReleaseDto["installedRelation"]): ReleaseDto {
  return {
    version,
    channel: "stable",
    publishedAt: "2026-10-20T08:00:00Z",
    sforumVersion: ">=1.0.0",
    status: "published",
    installedRelation: relation,
    assets: [{ os: "linux", arch: "amd64", filename: "demo.zip", size: 1024, sha256: "ab" }],
  };
}

function product(installedVersion: string | null, releases: ReleaseDto[]): ProductDto {
  return {
    slug: "demo",
    extensionId: "demo.plugin",
    name: "Demo",
    kind: "plugin",
    summary: "",
    socialImageUrl: null,
    installed: installedVersion === null ? null : { version: installedVersion, status: "enabled" },
    updateAvailable: false,
    latestVersion: releases[0]?.version ?? "0.0.0",
    readme: null,
    releases,
  };
}

function viewOf(installedVersion: string | null, releases: ReleaseDto[]) {
  return toProductView(product(installedVersion, releases));
}

describe("installGate", () => {
  test("no selected release is not installable", () => {
    const gate = installGate(viewOf(null, [release("1.0.0")]), null);
    expect(gate).toEqual({ installable: false, reason: "noRelease", installedVersion: null });
  });

  test("a release without an asset is not installable", () => {
    const dto: ReleaseDto = { ...release("1.0.0"), assets: [] };
    const view = toProductView(product(null, [dto]));
    const gate = installGate(view, view.releases[0]!);
    expect(gate).toEqual({ installable: false, reason: "noRelease", installedVersion: null });
  });

  test("not installed: the plain install action", () => {
    const view = viewOf(null, [release("1.0.0")]);
    expect(installGate(view, view.releases[0]!)).toEqual({ installable: true, upgrade: false });
  });

  test("a newer version is an upgrade", () => {
    const view = viewOf("1.0.0", [release("2.0.0", "newer"), release("1.0.0", "same")]);
    expect(installGate(view, view.releases[0]!)).toEqual({ installable: true, upgrade: true });
  });

  test("the same version is blocked: core would only replace the candidate", () => {
    const view = viewOf("1.0.0", [release("2.0.0", "newer"), release("1.0.0", "same")]);
    expect(installGate(view, view.releases[1]!)).toEqual({
      installable: false,
      reason: "installedSame",
      installedVersion: "1.0.0",
    });
  });

  test("an older version is blocked: migrations are not reversible", () => {
    const view = viewOf("2.0.0", [release("1.0.0", "older")]);
    expect(installGate(view, view.releases[0]!)).toEqual({
      installable: false,
      reason: "installedNewer",
      installedVersion: "2.0.0",
    });
  });

  test("an unparseable pair stays blocked without a verdict", () => {
    const view = viewOf("dev-abc12", [release("1.0.0", "unknown")]);
    expect(installGate(view, view.releases[0]!)).toEqual({
      installable: false,
      reason: "installedUnknown",
      installedVersion: "dev-abc12",
    });
  });

  test("a missing relation falls back to the previous behaviour instead of blocking", () => {
    // The backend computes a relation whenever the inventory answers, so this is the
    // "page newer than its backend" case: keep the button rather than hide an upgrade.
    const view = viewOf("1.0.0", [release("2.0.0")]);
    expect(installGate(view, view.releases[0]!)).toEqual({ installable: true, upgrade: false });
  });
});

describe("installGateText", () => {
  const blocked = (reason: "installedSame" | "installedNewer" | "installedUnknown") => ({
    installable: false as const,
    reason,
    installedVersion: "1.2.0",
  });
  const selected = toReleaseView(release("1.1.0"), ZH);

  test("an allowed install has no explanation", () => {
    expect(installGateText({ installable: true, upgrade: true }, selected, ZH)).toBe("");
  });

  test("same version names both sides once", () => {
    expect(installGateText(blocked("installedSame"), selected, ZH)).toBe(
      "已安装 v1.2.0，同版本无需再装",
    );
  });

  test("a downgrade names the selected and the installed version", () => {
    expect(installGateText(blocked("installedNewer"), selected, ZH)).toBe(
      "选中 v1.1.0 低于已安装的 v1.2.0",
    );
  });

  test("an uncomparable pair points at core", () => {
    expect(installGateText(blocked("installedUnknown"), selected, ZH)).toContain("无法比较版本");
  });

  test("en-US never falls back to Chinese", () => {
    const text = installGateText(blocked("installedNewer"), toReleaseView(release("1.1.0"), EN), EN);
    expect(text).toBe("v1.1.0 is older than the installed v1.2.0");
  });
});

describe("platform gate", () => {
  /** 只带一个平台的版本：用来把「架构判定」从「版本判定」里单独拎出来。 */
  function releaseFor(
    version: string,
    platforms: PlatformDto[],
    relation?: ReleaseDto["installedRelation"],
  ): ReleaseDto {
    return {
      ...release(version, relation),
      assets: platforms.map((platform) => ({
        os: platform.os,
        arch: platform.arch,
        filename: "demo.zip",
        size: 1024,
        sha256: "ab",
      })),
    };
  }

  test("another architecture blocks the install before any version comparison", () => {
    const view = toProductView(product("1.2.0", [releaseFor("1.2.0", [MAC], "same")]), ZH, LINUX);
    const gate = installGate(view, view.releases[0]!, LINUX);

    // 同版本本来也会被拦，但说的是「装不上」，不是「已装同版本」。
    expect(gate).toEqual({
      installable: false,
      reason: "platformUnsupported",
      installedVersion: "1.2.0",
    });
    expect(installGateText(gate, view.releases[0]!, ZH, LINUX)).toBe(
      "选中 v1.2.0 没有为 linux/amd64 构建的安装包",
    );
    expect(installGateText(gate, view.releases[0]!, EN, LINUX)).toBe(
      "v1.2.0 is not built for linux/amd64",
    );
  });

  test("without a target the version-only gate still decides", () => {
    // 老商城不回 target：页面没有基准，不能凭空把安装锁死。
    const view = toProductView(product("1.2.0", [releaseFor("1.2.0", [MAC], "same")]));
    expect(installGate(view, view.releases[0]!)).toEqual({
      installable: false,
      reason: "installedSame",
      installedVersion: "1.2.0",
    });
  });

  test("any/any stays installable on any architecture", () => {
    const view = toProductView(product(null, [releaseFor("1.0.0", [ANY_PLATFORM])]), ZH, LINUX);
    expect(installGate(view, view.releases[0]!, LINUX)).toEqual({
      installable: true,
      upgrade: false,
    });
  });

  test("a release with no assets keeps the noRelease reason", () => {
    const dto: ReleaseDto = { ...release("1.0.0"), assets: [] };
    const view = toProductView(product(null, [dto]), ZH, LINUX);
    expect(installGate(view, view.releases[0]!, LINUX)).toEqual({
      installable: false,
      reason: "noRelease",
      installedVersion: null,
    });
  });

  test("default platform never falls back to another architecture", () => {
    const view = toProductView(product(null, [releaseFor("1.0.0", [MAC])]), ZH, LINUX);
    expect(defaultPlatform(view.releases[0]!, LINUX)).toBeNull();
    // 没有 target 时保留改动前的行为：wildcard → 第一个资产。
    expect(defaultPlatform(view.releases[0]!, null)?.label).toBe("darwin/arm64");
  });

  test("default platform prefers any/any over a foreign asset", () => {
    const view = toProductView(
      product(null, [releaseFor("1.0.0", [MAC, ANY_PLATFORM])]),
      ZH,
      LINUX,
    );
    expect(defaultPlatform(view.releases[0]!, LINUX)?.label).toBe("任意平台");
  });
});

describe("relation labels", () => {
  test("each relation gets one wording in both locales", () => {
    expect(relationLabel("newer", ZH)).toBe("可升级");
    expect(relationLabel("same", ZH)).toBe("已安装");
    expect(relationLabel("older", ZH)).toBe("低于已安装");
    expect(relationLabel("unknown", ZH)).toBe("版本未比较");
    expect(relationLabel("older", EN)).toBe("older than installed");
  });

  test("no relation means no label, never a guessed one", () => {
    expect(relationLabel(null, ZH)).toBeNull();
  });

  test("an unknown wire value is ignored instead of leaking into the select", () => {
    const dto = { ...release("1.0.0"), installedRelation: "sideways" as never };
    const view = toReleaseView(dto, ZH);
    expect(view.relation).toBeNull();
    expect(view.relationLabel).toBeNull();
  });

  test("the view model carries the rendered notes HTML", () => {
    const dto: ReleaseDto = { ...release("1.0.0"), notes: "## x", notesHtml: "<h4>x</h4>" };
    expect(toReleaseView(dto, ZH).notesHtml).toBe("<h4>x</h4>");
    expect(toReleaseView({ ...dto, notesHtml: "" }, ZH).notesHtml).toBe("");
    expect(toReleaseView({ ...dto, notesHtml: null }, ZH).notesHtml).toBe("");
  });
});

describe("install failure phases", () => {
  /** 宿主在装好之后启用失败时抛出的错误：code 不变，多一个 phase。 */
  const activateFailure = (detail?: string) => {
    const error = new Error(detail ?? "install_failed") as Error & {
      code: string;
      phase: string;
    };
    error.code = "install_failed";
    error.phase = "activate";
    return error;
  };

  test("an activate failure never reads as an install failure", () => {
    expect(installFailurePhase(activateFailure())).toBe("activate");
    // 通用码会说「安装失败」；带 phase 的必须换一句，包已经在盘上了。
    expect(installFailureText(activateFailure(), ZH)).toBe(ZH.t("installEnableFailed"));
    expect(installFailureText(activateFailure(), ZH)).not.toBe(ZH.t("installFailed"));
    expect(installFailureText(activateFailure("extension.lifecycle_failed"), ZH)).toBe(
      ZH.t("installEnableFailedWith", { detail: "extension.lifecycle_failed" }),
    );
  });

  test("an install failure keeps the plain install wording", () => {
    const error = new Error("boom") as Error & { code: string; phase: string };
    error.code = "install_failed";
    error.phase = "install";
    expect(installFailurePhase(error)).toBe("install");
    expect(installFailureText(error, ZH)).toBe(ZH.t("installFailed"));
  });

  test("a failure without a phase is treated as a plain install failure", () => {
    const error = new Error("boom") as Error & { code: string };
    error.code = "install_failed";
    expect(installFailurePhase(error)).toBe("");
    expect(installFailureText(error, ZH)).toBe(ZH.t("installFailed"));
  });

  test("a made-up phase is ignored instead of steering the UI", () => {
    const error = new Error("boom") as Error & { code: string; phase: string };
    error.code = "install_failed";
    error.phase = "somewhere-else";
    expect(installFailurePhase(error)).toBe("");
    expect(installFailureText(error, EN)).toBe(EN.t("installFailed"));
  });
});

describe("authorView", () => {
  test("a full author prints the display name plus the login", () => {
    const view = authorView({
      username: "ada",
      displayName: "Ada Lovelace",
      avatarUrl: "https://forum.example/ada.png",
      profileUrl: "https://forum.example/u/ada",
      github: { login: "acme", url: "https://github.com/acme" },
    });
    expect(view).toEqual({
      name: "Ada Lovelace",
      hasForum: true,
      handle: "@ada",
      profileUrl: "https://forum.example/u/ada",
      avatarUrl: "https://forum.example/ada.png",
      initial: "A",
      github: { login: "acme", url: "https://github.com/acme" },
    });
  });

  test("a repository-only author prints the GitHub login", () => {
    const view = authorView({
      username: null,
      displayName: null,
      avatarUrl: null,
      github: { login: "acme", url: "https://github.com/acme" },
    });
    expect(view?.name).toBe("@acme");
    expect(view?.handle).toBeNull();
    expect(view?.github?.login).toBe("acme");
  });

  test("a forum-only author has no GitHub row", () => {
    const view = authorView({ username: "grace", displayName: null, avatarUrl: null, github: null });
    expect(view?.name).toBe("grace");
    expect(view?.handle).toBeNull();
    expect(view?.github).toBeNull();
  });

  test("a non-http profile URL is dropped: the handle becomes plain text, not a dead link", () => {
    const view = authorView({
      username: "ada",
      displayName: "Ada Lovelace",
      profileUrl: "javascript:alert(1)",
    });
    expect(view?.profileUrl).toBeNull();
    expect(view?.handle).toBe("@ada");
  });

  test("nothing at all means no strip", () => {
    expect(authorView(null)).toBeNull();
    expect(authorView(undefined)).toBeNull();
    expect(authorView({})).toBeNull();
  });

  test("a GitHub half without a url is dropped rather than rendered dead", () => {
    const view = authorView({
      username: "ada",
      github: { login: "acme", url: "" },
    });
    expect(view?.github).toBeNull();
    expect(view?.name).toBe("ada");
  });

  test("a release view keeps no relation when the backend sent none", () => {
    const view: ReleaseView = toReleaseView(release("1.0.0"), ZH);
    expect(view.relation).toBeNull();
    expect(view.relationLabel).toBeNull();
  });
});

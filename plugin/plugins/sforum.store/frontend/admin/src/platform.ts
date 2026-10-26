// 架构可用性：纯函数，无 DOM、无网络，所以能脱离宿主直接断言每一条分支。
//
// 商城给两组平台：`platforms` 是全部候选版本的并集，`latestPlatforms` 是卡片指向的那一版。
// 页面只回答一个问题：「这个包能不能在**这台服务器**上跑」。安装目标是服务器，不是管理员
// 浏览器，所以判定基准一律是插件后端回报的 `target`（宿主 GOOS/GOARCH）。
//
// 三种答案，缺一不可：
// - `true`   —— 明确支持；
// - `false`  —— 明确不支持（只有这时才拦）；
// - `null`   —— 没有基准（老商城不回 target）或没有平台信息。未知不是「不支持」：
//               D8 要求未知即放行，把判断交回 core 的启动诊断。

import type { PlatformDto, ReleaseView } from "./types";

type PlatformLike = Pick<PlatformDto, "os" | "arch">;
type TargetLike = Pick<PlatformDto, "os" | "arch"> | null | undefined;

/** `any/any` 是清单契约里唯一的通配平台（主题就是它）。 */
export function isAnyPlatform(platform: PlatformLike): boolean {
  return platform.os === "any" && platform.arch === "any";
}

export function samePlatform(left: PlatformLike, right: PlatformLike): boolean {
  return left.os === right.os && left.arch === right.arch;
}

/** `linux/amd64`：平台下拉的 value、签名请求的 os/arch 都是这个拼法。 */
export function platformId(platform: PlatformLike): string {
  return `${platform.os}/${platform.arch}`;
}

/**
 * 这组平台能不能在 `target` 上跑。
 *
 * 空数组返回 `null` 而不是 `false`：没有平台信息是「不知道」，不是「不支持」。旧后端、
 * 半截响应都会走到这里，判成 `false` 会把整页安装按钮误锁。
 */
export function supportsTarget(
  platforms: ReadonlyArray<PlatformLike> | null | undefined,
  target: TargetLike,
): boolean | null {
  if (!target || !target.os || !target.arch) return null;
  const list = platforms ?? [];
  if (!list.length) return null;
  return list.some((platform) => isAnyPlatform(platform) || samePlatform(platform, target));
}

/** 一个版本的资产平台里有没有当前架构（`any/any` 通配）。 */
export function releaseSupportsTarget(
  release: Pick<ReleaseView, "platforms"> | null | undefined,
  target: TargetLike,
): boolean | null {
  return supportsTarget(release?.platforms, target);
}

/**
 * 打开弹窗时默认选哪一版：最新的、可安装的、支持当前架构的那一版。
 *
 * `latestVersion` 是商城的「最新版」结论（稳定版口径），比数组顺序可靠，所以先认它；
 * 它不支持当前架构时才顺着数组往下找。全部不支持时返回 `null` —— 调用方会退到第一版并
 * 由安装门禁说明原因，而不是在这里偷偷选一个装不上的包。
 */
export function preferredRelease(
  releases: ReadonlyArray<ReleaseView>,
  target: TargetLike,
  latestVersion = "",
): ReleaseView | null {
  const usable = releases.filter(
    (release) => release.installable && releaseSupportsTarget(release, target) !== false,
  );
  if (!usable.length) return null;
  if (latestVersion) {
    const latest = usable.find((release) => release.version === latestVersion);
    if (latest) return latest;
  }
  return usable[0] ?? null;
}

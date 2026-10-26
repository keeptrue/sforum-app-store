// 页面文案表：zh-CN 与 en-US 两套 key 完全一致。
//
// 语言只由宿主给的 `bridge.locale` 决定（`AdminPageBridgeV1.locale: string`）：
// 以 `en` 开头 → en-US，其余（含缺失、空串、未知值）→ zh-CN。这里不引 i18n 库、
// 不调 `bridge.t`（宿主没有本插件的文案包），也不因为 locale 缺失抛错。
//
// 页面标题与简介由宿主页面壳渲染（清单里的 label / description），本表不再重复一份。
//
// 硬文案规则（任务书 §7.5 第 13–15 条）管的是**本页对成功的主张**：只写宿主真正做完的事，
// 不出现「已验证构建 / verified build」「自动升级 / auto-upgrade」。
// 两个例外都是「转述宿主的事实」，不是本页把包装上了：
// 1. 来源为宿主已装清单的徽标（`installedBadge` / `updateBadge`）：说的是这台宿主装了什么；
// 2. 宿主在 `installAndEnableExtension` 回执里给出的 `outcome`（`enabled` / `upgraded`）：
//    文案一律写成「宿主已启用 / 宿主已升级」，绝不说成本页启用或本页自动升级。
// 没有 `outcome`（旧宿主）或 `outcome: "staged"` 时，仍然只说「已暂存」并指向 core。

export type Locale = "zh-CN" | "en-US";

const ZH = {
  searchPlaceholder: "名称、扩展 ID、简介",
  searchAria: "搜索扩展",
  searchField: "搜索",
  channelField: "频道",
  channelAria: "发布频道",
  categoryField: "分类",
  categoryAria: "分类",
  refreshAction: "刷新",
  compatOnlyAction: "只看当前版本可安装",

  resultCount: "共 {count} 个结果",
  resultCountOne: "共 1 个结果",
  staleNotice: "数据更新于 {time}（商城暂不可达，显示缓存）",

  catalogAria: "商城目录",
  cardAria: "查看{name}的详情",
  cardMetaOverflow: "+{count}",

  catalogLoading: "正在加载商城目录…",
  catalogErrorTitle: "目录加载失败",
  catalogUnreachable: "无法连接商城",
  retryAction: "重试",
  recheckAction: "重新检查",
  setupTitle: "还没配置商城地址",
  setupText: "到 应用商城 设置里填写商城地址",
  emptyTitle: "没有匹配的扩展",
  emptyText: "换个关键词，或把频道切到 含预发布。",
  loadMore: "加载更多",
  loadMorePending: "加载中…",

  dialogClose: "关闭",
  dialogTabsAria: "扩展详情分区",
  tabReadme: "README",
  tabVersions: "版本信息",
  tabNotes: "更新说明",
  notesEmpty: "这个产品还没有更新说明。",

  detailLoading: "正在加载扩展详情…",
  detailErrorTitle: "详情加载失败",
  detailUnavailable: "无法加载扩展详情",
  detailPlatformUnsupported:
    "最新版 v{version} 没有为 {platform} 构建的安装包，已为你选中 v{selected}。",
  detailNoSupportedRelease: "这个产品的所有版本都没有为 {platform} 构建的安装包。",
  reloadAction: "重新加载",

  channelStable: "稳定版",
  channelBeta: "预发布",
  channelAll: "含预发布",
  categoryAll: "全部分类",
  categoryContent: "内容",
  categoryAppearance: "外观主题",
  categoryCommunity: "社区功能",
  categoryIntegration: "集成",
  categoryOps: "运维",
  categorySecurity: "安全",

  kindPlugin: "插件",
  kindTheme: "主题",
  compatibleLabel: "兼容",
  incompatibleLabel: "不兼容",
  platformSupportedBadge: "支持当前架构",
  platformUnsupportedBadge: "不支持当前架构",
  platformLatestUnsupportedBadge: "最新版不支持当前架构",
  platformUnsupportedCardTitle:
    "最新版 v{version} 没有为当前架构构建的安装包，目录里还有能装的旧版本。",
  compatUnjudgedNote:
    "当前宿主没有给出可用的版本号，本页只展示 sforumVersion 约束；兼容性由 core 在安装时判定。",
  compatDevAllNote: "开发版宿主：默认显示全部（不按版本过滤）；兼容性以安装时 core 的判定为准。",
  compatDevFilteredNote:
    "开发版宿主：已按版本约束筛选；开发版的版本号来自最近的 git tag，仅供参考；能否安装以 core 判定为准。",
  compatFilteredNote: "已按宿主版本与各版本的 sforumVersion 约束筛选；能否安装以 core 判定为准。",
  compatAllNote: "正在显示全部扩展（含与本版本不匹配的）；兼容性由 core 在安装时判定。",
  installedBadge: "已安装 v{version}",
  updateBadge: "可更新至 v{version}",
  installedStatusDisabled: "已在宿主停用",
  installedStatusUnenabled: "已装，尚未启用",
  installedStatusOther: "宿主状态：{status}",
  platformAny: "任意平台",
  statusPublished: "已发布",
  statusYanked: "已撤回",
  statusUnknown: "未知",

  readmeEmpty: "这个产品还没有可展示的 README。",
  readmeSource: "在 GitHub 查看",
  versionsCaption: "版本列表",
  labelVersion: "版本",
  labelChannel: "频道",
  labelDate: "日期",
  labelConstraint: "sforum 约束",
  labelCapabilities: "能力",
  labelDigest: "摘要",
  labelPackageDigest: "制品摘要：",

  noInstallableVersion: "没有可安装的版本",
  noInstallTarget: "没有可安装的版本或平台",
  versionSelectAria: "选择版本",
  versionOption: "{version} · {channel}",
  versionOptionWithRelation: "{version} · {channel} · {relation}",
  versionOptionUnsupported: "{version} · {channel} · 不支持当前架构",
  platformSupportedState: "支持当前架构（{platform}）",
  installAction: "安装到论坛",
  installUpdateAction: "更新到 v{version}",
  installedAction: "已安装 v{version}",
  installBlockedSame: "已安装 v{installed}，同版本无需再装",
  installBlockedOlder: "选中 v{version} 低于已安装的 v{installed}",
  installBlockedUnknown: "无法比较版本（已安装 {installed}），请到 core 处理",
  installBlockedPlatform: "选中 v{version} 没有为 {platform} 构建的安装包",
  authorProfileTitle: "论坛个人主页",
  relationNewer: "可升级",
  relationSame: "已安装",
  relationOlder: "低于已安装",
  relationUnknown: "版本未比较",
  authorAria: "维护者",
  authorGithubAccount: "GitHub 仓库账号",
  installAndEnableAction: "安装并启用",
  installUpdateAndEnableAction: "更新并启用 v{version}",
  installPendingAction: "安装中…",
  installAndEnablePendingAction: "安装并启用中…",
  installKeepPageOpen: "安装期间不要关闭页面",
  installBusy: "已有安装在进行",
  installBusyHint: "等当前安装结束后再试",
  installEnableHint: "安装后会自动启用；未信任的可执行后端包仍要超级管理员先确认一次。",
  stagedTitle: "已暂存",
  trustNote: "启用与信任在 core 完成",
  stagedUpgradedHint: "这是已启用扩展的新版本，去 core 完成升级。",
  stagedTrustHint: "该包带可执行后端，启用前还需要在 core 完成制品信任。",
  enabledTitle: "已启用",
  enabledNote: "宿主已启用这个扩展，不用再去 core。",
  upgradedTitle: "已升级",
  upgradedNote: "宿主已把已启用的扩展升级到这个版本。",
  partialTitle: "已安装，尚未启用",
  partialNote: "包已经装好，启用没成功；去 core 的扩展页启用即可，不用重新安装。",
  installEnableFailed: "包已经装好，但宿主没能启用它",
  installEnableFailedWith: "包已经装好，但宿主没能启用它（{detail}）",
  stagedThemeNote: "主题装好后要到主题页选择并激活。",
  openCoreAction: "打开 core 扩展页",
  openCoreThemeAction: "去主题页激活",
  openCoreInstallAction: "打开 core 安装页",

  legacyHostNotice: "当前宿主不支持页面内安装",
  signAction: "获取签名链接",
  signPendingAction: "获取中…",
  signedReadyTitle: "已生成签名链接",
  signedValidHint: "链接 30 分钟内有效",
  signNotConfigured: "商城地址还没配置，无法签发安装链接",
  signFailed: "无法签发安装链接",
  signFailedWith: "无法签发安装链接（{detail}）",
  signedUrlLabel: "签名下载链接",
  copyLinkAction: "复制链接",
  signedHint: "链接 30 分钟内有效{expires}；在 core 的扩展安装页粘贴链接与 SHA-256。",
  signedExpires: "（约到 {time}）",
  sha256Label: "SHA-256：",
  copiedTitle: "已复制",
  copyFailedTitle: "复制失败",
  copyFailedHint: "请手动选中链接复制",

  installPermissionDenied: "没有安装权限",
  installCancelled: "已取消（离开页面会中断安装）",
  installInvalidRequest: "请求无效",
  expectedMismatch: "包与目录声明的身份不一致",
  installFailed: "安装失败",
  installFailedWithCode: "安装失败（{code}）",
};

export type CopyKey = keyof typeof ZH;

const EN: Record<CopyKey, string> = {
  searchPlaceholder: "Name, extension ID, or summary",
  searchAria: "Search extensions",
  searchField: "Search",
  channelField: "Channel",
  channelAria: "Release channel",
  categoryField: "Category",
  categoryAria: "Category",
  refreshAction: "Refresh",
  compatOnlyAction: "Only show what this version can install",

  resultCount: "{count} results",
  resultCountOne: "1 result",
  staleNotice: "Cached data from {time} (the store is unreachable)",

  catalogAria: "Store catalog",
  cardAria: "View details for {name}",
  cardMetaOverflow: "+{count}",

  catalogLoading: "Loading the store catalog…",
  catalogErrorTitle: "Could not load the catalog",
  catalogUnreachable: "Could not reach the store",
  retryAction: "Retry",
  recheckAction: "Check again",
  setupTitle: "The store URL is not configured",
  setupText: "Set the store URL in the App Store settings",
  emptyTitle: "No matching extensions",
  emptyText: "Try another keyword, or switch the channel to include pre-releases.",
  loadMore: "Load more",
  loadMorePending: "Loading…",

  dialogClose: "Close",
  dialogTabsAria: "Extension detail sections",
  tabReadme: "README",
  tabVersions: "Versions",
  tabNotes: "Release notes",
  notesEmpty: "This product has no release notes yet.",

  detailLoading: "Loading the extension details…",
  detailErrorTitle: "Could not load the details",
  detailUnavailable: "Could not load the extension details",
  detailPlatformUnsupported:
    "The latest v{version} is not built for {platform}, so v{selected} is selected.",
  detailNoSupportedRelease: "No release of this product is built for {platform}.",
  reloadAction: "Reload",

  channelStable: "Stable",
  channelBeta: "Pre-release",
  channelAll: "Include pre-releases",
  categoryAll: "All categories",
  categoryContent: "Content",
  categoryAppearance: "Appearance",
  categoryCommunity: "Community",
  categoryIntegration: "Integrations",
  categoryOps: "Operations",
  categorySecurity: "Security",

  kindPlugin: "Plugin",
  kindTheme: "Theme",
  compatibleLabel: "Compatible",
  incompatibleLabel: "Incompatible",
  platformSupportedBadge: "Supported on this platform",
  platformUnsupportedBadge: "Not built for this platform",
  platformLatestUnsupportedBadge: "Latest version not built for this platform",
  platformUnsupportedCardTitle:
    "The latest v{version} is not built for this architecture; older installable releases exist.",
  compatUnjudgedNote:
    "This host does not report a usable version, so only sforumVersion constraints are shown; core decides compatibility at install time.",
  compatDevAllNote:
    "Development host: everything is listed by default (no version filtering); core decides compatibility at install time.",
  compatDevFilteredNote:
    "Development host: filtered by version constraint; the development version comes from the latest git tag and is approximate. Core decides whether an install is allowed.",
  compatFilteredNote:
    "Listed extensions match this host version and their sforumVersion constraints; core decides whether an install is allowed.",
  compatAllNote:
    "All extensions are listed, including ones that do not match this host version; core decides compatibility at install time.",
  installedBadge: "Installed v{version}",
  updateBadge: "Update to v{version}",
  installedStatusDisabled: "Disabled in this host",
  installedStatusUnenabled: "Installed but not enabled yet",
  installedStatusOther: "Host status: {status}",
  platformAny: "Any platform",
  statusPublished: "Published",
  statusYanked: "Yanked",
  statusUnknown: "Unknown",

  readmeEmpty: "This product has no README to show yet.",
  readmeSource: "View on GitHub",
  versionsCaption: "Version list",
  labelVersion: "Version",
  labelChannel: "Channel",
  labelDate: "Date",
  labelConstraint: "sforum constraint",
  labelCapabilities: "Capabilities",
  labelDigest: "Digest",
  labelPackageDigest: "Package digest: ",

  noInstallableVersion: "No installable version",
  noInstallTarget: "No installable version or platform",
  versionSelectAria: "Select a version",
  versionOption: "{version} · {channel}",
  versionOptionWithRelation: "{version} · {channel} · {relation}",
  versionOptionUnsupported: "{version} · {channel} · not built for this platform",
  platformSupportedState: "Supported on this platform ({platform})",
  installAction: "Install to forum",
  installUpdateAction: "Update to v{version}",
  installedAction: "Installed v{version}",
  installBlockedSame: "v{installed} is already installed; the same version needs no second install",
  installBlockedOlder: "v{version} is older than the installed v{installed}",
  installBlockedUnknown: "Cannot compare versions (installed {installed}); finish this in core",
  installBlockedPlatform: "v{version} is not built for {platform}",
  authorProfileTitle: "Forum profile",
  relationNewer: "upgrade",
  relationSame: "installed",
  relationOlder: "older than installed",
  relationUnknown: "not compared",
  authorAria: "Maintainer",
  authorGithubAccount: "GitHub repository account",
  installAndEnableAction: "Install and enable",
  installUpdateAndEnableAction: "Update and enable v{version}",
  installPendingAction: "Installing…",
  installAndEnablePendingAction: "Installing and enabling…",
  installKeepPageOpen: "Do not close this page during the install",
  installBusy: "An install is already running",
  installBusyHint: "Try again once the current install finishes",
  installEnableHint:
    "It is enabled automatically after installing; an untrusted executable backend still needs a super administrator to confirm once.",
  stagedTitle: "Staged",
  trustNote: "Enabling and trusting happen in core",
  stagedUpgradedHint: "This is a newer version of an enabled extension; finish the upgrade in core.",
  stagedTrustHint:
    "This package ships an executable backend, so core also needs an artifact trust confirmation before enabling.",
  enabledTitle: "Enabled",
  enabledNote: "The host enabled this extension; core needs nothing further.",
  upgradedTitle: "Upgraded",
  upgradedNote: "The host upgraded the enabled extension to this version.",
  partialTitle: "Installed, not enabled",
  partialNote: "The package is installed but enabling did not succeed; enable it on the core extensions page, no reinstall needed.",
  installEnableFailed: "The package is installed, but the host could not enable it",
  installEnableFailedWith: "The package is installed, but the host could not enable it ({detail})",
  stagedThemeNote: "A theme must be chosen and activated on the themes page.",
  openCoreAction: "Open the core extensions page",
  openCoreThemeAction: "Open themes to activate",
  openCoreInstallAction: "Open the core install page",

  legacyHostNotice: "This host does not support in-page installs",
  signAction: "Get a signed link",
  signPendingAction: "Requesting…",
  signedReadyTitle: "Signed link ready",
  signedValidHint: "The link is valid for 30 minutes",
  signNotConfigured: "The store URL is not configured, so no install link can be signed",
  signFailed: "Could not sign an install link",
  signFailedWith: "Could not sign an install link ({detail})",
  signedUrlLabel: "Signed download link",
  copyLinkAction: "Copy link",
  signedHint:
    "The link is valid for 30 minutes{expires}; paste the link and the SHA-256 on core's extension install page.",
  signedExpires: " (until about {time})",
  sha256Label: "SHA-256: ",
  copiedTitle: "Copied",
  copyFailedTitle: "Copy failed",
  copyFailedHint: "Select the link and copy it manually",

  installPermissionDenied: "No permission to install",
  installCancelled: "Cancelled (leaving the page aborts the install)",
  installInvalidRequest: "Invalid request",
  expectedMismatch: "The package does not match the declared identity",
  installFailed: "Install failed",
  installFailedWithCode: "Install failed ({code})",
};

export const COPY_TABLES: Readonly<Record<Locale, Readonly<Record<CopyKey, string>>>> = {
  "zh-CN": ZH,
  "en-US": EN,
};

/** 稳定安装失败码的文案表；`extension.expected_mismatch` 来自宿主的身份比对。 */
export const INSTALL_FAILURE_ZH: Readonly<Record<string, string>> = {
  install_permission_denied: ZH.installPermissionDenied,
  install_cancelled: ZH.installCancelled,
  install_in_progress: ZH.installBusy,
  install_invalid_request: ZH.installInvalidRequest,
  install_failed: ZH.installFailed,
  "extension.expected_mismatch": ZH.expectedMismatch,
};

export const INSTALL_FAILURE_EN: Readonly<Record<string, string>> = {
  install_permission_denied: EN.installPermissionDenied,
  install_cancelled: EN.installCancelled,
  install_in_progress: EN.installBusy,
  install_invalid_request: EN.installInvalidRequest,
  install_failed: EN.installFailed,
  "extension.expected_mismatch": EN.expectedMismatch,
};

export type CopyParams = Record<string, string | number>;

export type Copy = {
  locale: Locale;
  /** 取一条文案；`{name}` 占位按 params 替换，缺参数时保留占位符。 */
  t(key: CopyKey, params?: CopyParams): string;
  /** 安装失败码 → 文案。 */
  failure: Readonly<Record<string, string>>;
};

/**
 * `en…` → en-US，其它一切（含 undefined / null / 空串 / 数字 / 未知语言）→ zh-CN。
 * 这是唯一读 `bridge.locale` 的地方，且永不抛错。
 */
export function resolveLocale(value: unknown): Locale {
  if (typeof value !== "string") return "zh-CN";
  return value.trim().toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

function interpolate(template: string, params: CopyParams): string {
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token,
  );
}

export function createCopy(locale?: unknown): Copy {
  const resolved = resolveLocale(locale);
  const table = COPY_TABLES[resolved];
  return {
    locale: resolved,
    t(key: CopyKey, params?: CopyParams): string {
      const template = table[key] ?? ZH[key] ?? String(key);
      return params ? interpolate(template, params) : template;
    },
    failure: resolved === "en-US" ? INSTALL_FAILURE_EN : INSTALL_FAILURE_ZH,
  };
}

/** zh-CN 默认实例：纯函数的默认参数用它，避免每次调用新建对象。 */
export const ZH_COPY: Copy = createCopy("zh-CN");

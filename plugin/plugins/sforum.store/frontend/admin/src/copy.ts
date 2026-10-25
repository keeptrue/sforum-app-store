// 页面文案表：zh-CN 与 en-US 两套 key 完全一致。
//
// 语言只由宿主给的 `bridge.locale` 决定（`AdminPageBridgeV1.locale: string`）：
// 以 `en` 开头 → en-US，其余（含缺失、空串、未知值）→ zh-CN。这里不引 i18n 库、
// 不调 `bridge.t`（宿主没有本插件的文案包），也不因为 locale 缺失抛错。
//
// 硬文案规则（任务书 §7.5 第 13–15 条）在两种语言里都成立：成功只写「已暂存 / Staged」
// 并指向 core 的信任与启用；不出现「已安装 / installed」「已更新 / updated」
// 「已验证构建 / verified build」「自动升级」。

export type Locale = "zh-CN" | "en-US";

const ZH = {
  pageTitle: "应用商城",
  pageLede: "浏览商城目录，把选中的插件或主题交给 core 暂存；启用与信任在 core 完成。",

  searchPlaceholder: "名称、扩展 ID、简介",
  searchAria: "搜索扩展",
  searchField: "搜索",
  channelField: "频道",
  channelAria: "发布频道",
  categoryField: "分类",
  categoryAria: "分类",
  refreshAction: "刷新",

  resultCount: "共 {count} 个结果",
  resultCountOne: "共 1 个结果",
  staleNotice: "数据更新于 {time}（商城暂不可达，显示缓存）",

  prevPage: "上一页",
  nextPage: "下一页",

  catalogHeading: "目录",
  catalogAria: "商城目录",
  detailAria: "扩展详情",

  catalogLoading: "正在加载商城目录…",
  catalogErrorTitle: "目录加载失败",
  catalogUnreachable: "无法连接商城",
  retryAction: "重试",
  recheckAction: "重新检查",
  setupTitle: "还没配置商城地址",
  setupText: "到 应用商城 设置里填写商城地址",
  emptyTitle: "没有匹配的扩展",
  emptyText: "换个关键词，或把频道切到 含预发布。",

  detailIdle: "从左侧目录选择一个扩展查看详情。",
  detailLoading: "正在加载扩展详情…",
  detailErrorTitle: "详情加载失败",
  detailUnavailable: "无法加载扩展详情",
  reloadAction: "重新加载",
  detailNoSelection: "没有选中扩展。",
  platformsInline: "平台：{list}",

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
  estimatedLabel: "按开发版估算",
  compatUnjudgedNote:
    "当前宿主没有暴露版本号，本页只展示 sforumVersion 约束；兼容性由 core 在安装时判定。",
  compatEstimatedNote: "宿主是开发版构建，兼容性按开发版估算。",
  compatFilteredNote: "已按宿主版本筛出一份可安装的目录。",
  platformAny: "任意平台",
  statusPublished: "已发布",
  statusYanked: "已撤回",
  statusUnknown: "未知",

  notesTitle: "更新说明 {version}",
  readmeTitle: "README",
  readmeEmpty: "这个产品还没有可展示的 README。",
  readmeSource: "在 GitHub 查看",
  versionsTitle: "版本",
  versionsCaption: "版本列表",
  labelVersion: "版本",
  labelChannel: "频道",
  labelDate: "日期",
  labelConstraint: "sforum 约束",
  labelCapabilities: "能力",
  labelDigest: "摘要",
  labelExtensionId: "扩展 ID",

  noInstallableVersion: "没有可安装的版本",
  noInstallTarget: "没有可安装的版本或平台",
  versionSelectAria: "选择版本",
  platformSelectAria: "选择平台",
  labelPlatform: "平台",
  versionOption: "{version} · {channel}",
  installAction: "安装到论坛",
  installPendingAction: "安装中…",
  installKeepPageOpen: "安装期间不要关闭页面",
  installBusy: "已有安装在进行",
  installBusyHint: "等当前安装结束后再试",
  stagedTitle: "已暂存",
  trustNote: "启用与信任在 core 完成",
  stagedUpgradedHint: "这是已启用扩展的新版本，去 core 完成升级。",
  stagedTrustHint: "该包带可执行后端，启用前还需要在 core 完成制品信任。",
  openCoreAction: "打开 core 扩展页",
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
  pageTitle: "App Store",
  pageLede:
    "Browse the store catalog and hand the plugin or theme you pick to core for staging; enabling and trusting happen in core.",

  searchPlaceholder: "Name, extension ID, or summary",
  searchAria: "Search extensions",
  searchField: "Search",
  channelField: "Channel",
  channelAria: "Release channel",
  categoryField: "Category",
  categoryAria: "Category",
  refreshAction: "Refresh",

  resultCount: "{count} results",
  resultCountOne: "1 result",
  staleNotice: "Cached data from {time} (the store is unreachable)",

  prevPage: "Previous",
  nextPage: "Next",

  catalogHeading: "Catalog",
  catalogAria: "Store catalog",
  detailAria: "Extension details",

  catalogLoading: "Loading the store catalog…",
  catalogErrorTitle: "Could not load the catalog",
  catalogUnreachable: "Could not reach the store",
  retryAction: "Retry",
  recheckAction: "Check again",
  setupTitle: "The store URL is not configured",
  setupText: "Set the store URL in the App Store settings",
  emptyTitle: "No matching extensions",
  emptyText: "Try another keyword, or switch the channel to include pre-releases.",

  detailIdle: "Select an extension from the catalog to see its details.",
  detailLoading: "Loading the extension details…",
  detailErrorTitle: "Could not load the details",
  detailUnavailable: "Could not load the extension details",
  reloadAction: "Reload",
  detailNoSelection: "No extension selected.",
  platformsInline: "Platforms: {list}",

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
  estimatedLabel: "Estimated from a dev build",
  compatUnjudgedNote:
    "This host does not expose its version, so only sforumVersion constraints are shown; core decides compatibility at install time.",
  compatEstimatedNote:
    "The host is a dev build, so compatibility is estimated from the development version.",
  compatFilteredNote: "Only extensions this host version can install are listed.",
  platformAny: "Any platform",
  statusPublished: "Published",
  statusYanked: "Yanked",
  statusUnknown: "Unknown",

  notesTitle: "Release notes {version}",
  readmeTitle: "README",
  readmeEmpty: "This product has no README to show yet.",
  readmeSource: "View on GitHub",
  versionsTitle: "Versions",
  versionsCaption: "Version list",
  labelVersion: "Version",
  labelChannel: "Channel",
  labelDate: "Date",
  labelConstraint: "sforum constraint",
  labelCapabilities: "Capabilities",
  labelDigest: "Digest",
  labelExtensionId: "Extension ID",

  noInstallableVersion: "No installable version",
  noInstallTarget: "No installable version or platform",
  versionSelectAria: "Select a version",
  platformSelectAria: "Select a platform",
  labelPlatform: "Platform",
  versionOption: "{version} · {channel}",
  installAction: "Install to forum",
  installPendingAction: "Installing…",
  installKeepPageOpen: "Do not close this page during the install",
  installBusy: "An install is already running",
  installBusyHint: "Try again once the current install finishes",
  stagedTitle: "Staged",
  trustNote: "Enabling and trusting happen in core",
  stagedUpgradedHint: "This is a newer version of an enabled extension; finish the upgrade in core.",
  stagedTrustHint:
    "This package ships an executable backend, so core also needs an artifact trust confirmation before enabling.",
  openCoreAction: "Open the core extensions page",
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

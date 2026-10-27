// Unit + DOM tests for the store admin page. Runs with `bun test frontend/admin/src`.
// The repository has no DOM dependency, so `test-dom.ts` provides the minimal shim;
// layout/CSS/disabled-click semantics are NOT covered here (see /tmp harness + report).

import { beforeEach, describe, expect, test } from "bun:test";

import { mount, apiVersion } from "./catalog";
import { COPY_TABLES, createCopy, resolveLocale } from "./copy";
import type { CopyKey } from "./copy";
import {
  CORE_INSTALL_PATH,
  CORE_PLUGINS_PATH,
  CORE_THEMES_PATH,
  INSTALL_FAILURE_TEXT,
  INSTALL_FAILURE_TEXT_EN,
  buildCatalogPath,
  buildInstallRequest,
  buildInstallUrlBody,
  buildProductPath,
  categoryOptions,
  channelOptions,
  classifyFailure,
  compatibilityNote,
  compatibilityView,
  constraintChip,
  digestPrefix,
  installFailureText,
  installedStatusNote,
  installedView,
  parseCatalog,
  parseInstallUrl,
  parseProduct,
  resolveAppliedCompat,
  defaultPlatform,
  platformLabel,
  toCatalogItemView,
  toProductView,
} from "./logic";
import { installDom, toHTML } from "./test-dom";
import type {
  PageBridge,
  HostInstallEnableResult,
  HostInstallRequest,
  HostInstallResult,
} from "./types";

/** `/api/store/auth/start` 的默认响应：授权页与商城同源（页面只做展示，不校验）。 */
const AUTH_START = {
  requestId: "11111111-1111-4111-8111-111111111111",
  authorizeUrl: "https://store.example.test/connect/11111111-1111-4111-8111-111111111111",
  expiresIn: 300,
  interval: 2,
};

const CATALOG = {
  items: [
    {
      slug: "markdown",
      extensionId: "demo.markdown",
      name: "Markdown 增强",
      kind: "plugin" as const,
      summary: "补齐 Markdown 语法。",
      category: "content",
      latestVersion: "1.4.2",
      sforumVersion: ">=1.0.0 <2.0.0",
      platforms: [
        { os: "linux", arch: "amd64" },
        { os: "darwin", arch: "arm64" },
      ],
      compatibility: { status: "unknown" as const, estimated: true },
    },
    {
      slug: "aurora",
      extensionId: "demo.aurora",
      name: "Aurora 主题",
      kind: "theme" as const,
      summary: "深色主题。",
      category: "appearance",
      latestVersion: "0.9.0",
      sforumVersion: "",
      platforms: [{ os: "any", arch: "any" }],
      compatibility: { status: "compatible" as const, estimated: false },
    },
  ],
  total: 2,
  nextCursor: "cursor-2",
  compatibility: { status: "unknown" as const, estimated: false },
  stale: true,
  fetchedAt: "2026-10-24T11:30:00Z",
};

// The store renders and sanitises the repository README; the page only injects this HTML.
const README = {
  html: "<h1>Markdown 增强</h1>\n<p>第一段。</p>\n<pre><code>bun test</code></pre>",
  sourceUrl: "https://github.com/example/markdown/blob/main/README.md",
  sha: "c".repeat(40),
  fetchedAt: "2026-10-24T10:00:00Z",
  byteSize: 2048,
};

const PRODUCT = {
  product: {
    slug: "markdown",
    extensionId: "demo.markdown",
    name: "Markdown 增强",
    kind: "plugin" as const,
    summary: "补齐 Markdown 语法。",
    category: "content",
    latestVersion: "1.4.2",
    platforms: [
      { os: "linux", arch: "amd64" },
      { os: "darwin", arch: "arm64" },
    ],
    readme: README,
    releases: [
      {
        version: "1.4.2",
        channel: "stable" as const,
        publishedAt: "2026-10-20T08:00:00Z",
        sforumVersion: ">=1.0.0 <2.0.0",
        status: "published",
        digest: "9f2c1b7d4e5a6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
        capabilities: ["host.api", "net.outbound"],
        assets: [
          { os: "linux", arch: "amd64", filename: "demo.zip", size: 1024, sha256: "9f2c" },
          { os: "darwin", arch: "arm64", filename: "demo.zip", size: 1024, sha256: "9f2c" },
        ],
      },
      {
        version: "1.5.0-beta.1",
        channel: "beta" as const,
        publishedAt: "2026-10-22T08:00:00Z",
        sforumVersion: ">=1.0.0",
        status: "published",
        digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        assets: [{ os: "linux", arch: "amd64", filename: "demo.zip", size: 1024, sha256: "aaaa" }],
      },
      {
        version: "1.3.0",
        channel: "stable" as const,
        publishedAt: "2026-09-01T08:00:00Z",
        sforumVersion: ">=1.0.0",
        status: "yanked",
        assets: [],
      },
    ],
  },
};

const THEME_PRODUCT = {
  product: {
    slug: "aurora",
    extensionId: "demo.aurora",
    name: "Aurora 主题",
    kind: "theme" as const,
    summary: "深色主题。",
    category: "appearance",
    latestVersion: "0.9.0",
    readme: null,
    platforms: [{ os: "any", arch: "any" }],
    releases: [
      {
        version: "0.9.0",
        channel: "stable" as const,
        publishedAt: "2026-10-01T00:00:00Z",
        sforumVersion: ">=1.0.0",
        status: "published",
        digest: "b".repeat(64),
        assets: [{ os: "any", arch: "any", filename: "theme.zip", size: 1, sha256: "b" }],
      },
    ],
  },
};

// ASCII-only fixtures: rendering these in en-US must leave no Chinese at all,
// which is how "every user-visible string went through the copy table" is checked.
const ASCII_CATALOG = {
  ...CATALOG,
  items: CATALOG.items.map((item, index) => ({
    ...item,
    name: index === 0 ? "Markdown Plus" : "Aurora Theme",
    summary: "ASCII summary.",
  })),
};

const ASCII_PRODUCT = {
  product: {
    ...PRODUCT.product,
    name: "Markdown Plus",
    summary: "ASCII summary.",
    readme: {
      ...README,
      html: "<h1>Markdown Plus</h1>\n<p>First paragraph.</p>",
    },
    releases: PRODUCT.product.releases.map((release) => ({ ...release, notes: "ASCII release notes." })),
  },
};

// 封面、已装标记的夹具各自一份：主夹具保持「旧后端」形状（没有新字段），
// 这样「缺字段不崩」本身也是一条被测事实。
const COVER = "https://store.example.com/api/assets/".concat("d".repeat(64));
const COVER_ICON = "https://store.example.com/api/assets/".concat("e".repeat(64));

const compatibleCatalog = () => ({
  ...CATALOG,
  compatibility: { status: "compatible" as const, estimated: false },
});

const coveredCatalog = () => ({
  ...CATALOG,
  items: CATALOG.items.map((item, index) =>
    index === 0 ? { ...item, socialImageUrl: COVER, iconUrl: COVER_ICON } : item,
  ),
});

const installedCatalog = () => ({
  ...CATALOG,
  items: CATALOG.items.map((item, index) =>
    index === 0
      ? { ...item, installed: { version: "1.2.0", status: "enabled" }, updateAvailable: true }
      : item,
  ),
});

const installedProduct = () => ({
  product: {
    ...PRODUCT.product,
    installed: { version: "1.2.0", status: "disabled" },
    updateAvailable: true,
  },
});

const asciiInstalledCatalog = () => ({
  ...ASCII_CATALOG,
  items: ASCII_CATALOG.items.map((item, index) =>
    index === 0
      ? { ...item, installed: { version: "1.2.0", status: "enabled" }, updateAvailable: true }
      : item,
  ),
});

const asciiInstalledProduct = () => ({
  product: {
    ...ASCII_PRODUCT.product,
    installed: { version: "1.2.0", status: "disabled" },
    updateAvailable: true,
  },
});

const SIGNED = {
  url: "https://store.example.com/api/v1/download/eyJhIjoxfQ.sig",
  sha256: "9f2c1b7d4e5a6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
  size: 20480,
  expiresAt: "2026-10-24T12:30:00Z",
};

const RESULT: HostInstallResult = {
  extensionId: "demo.markdown",
  version: "1.4.2",
  type: "plugin",
  packageDigest: SIGNED.sha256,
  upgraded: false,
  requiresTrust: true,
};

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

type RequestLog = { path: string; options?: Record<string, unknown> };

type FakeBridge = PageBridge & {
  requests: RequestLog[];
  toasts: Array<{ title: string; description?: string; kind?: string }>;
  navigations: string[];
  installCalls: HostInstallRequest[];
  /** 走新方法（安装并启用）的调用；旧方法走 installCalls。 */
  enableCalls: HostInstallRequest[];
};

function fakeBridge(options: {
  configured?: boolean;
  install?: boolean;
  /** 连接商城的响应；默认匿名模式（不显示连接条）。 */
  authStatus?: unknown;
  authStart?: unknown;
  authPoll?: unknown;
  installImpl?: (request: HostInstallRequest) => Promise<HostInstallResult>;
  /** 新宿主：同时提供 installAndEnableExtension（`outcome` 由用例决定）。 */
  enable?: boolean;
  enableImpl?: (request: HostInstallRequest) => Promise<HostInstallEnableResult>;
  locale?: unknown;
  catalog?: unknown;
  product?: unknown;
} = {}): FakeBridge {
  const requests: RequestLog[] = [];
  const toasts: FakeBridge["toasts"] = [];
  const navigations: string[] = [];
  const installCalls: HostInstallRequest[] = [];
  const enableCalls: HostInstallRequest[] = [];
  const bridge: FakeBridge = {
    requests,
    toasts,
    navigations,
    installCalls,
    enableCalls,
    request: async (path: string, requestOptions?: Record<string, unknown>) => {
      requests.push({ path, options: requestOptions });
      if (options.configured === false) {
        const error = new Error("not configured") as Error & Record<string, unknown>;
        error.status = 503;
        error.data = { code: "not_configured", message: "catalog proxy is not configured" };
        throw error;
      }
      if (path.startsWith("/api/store/catalog")) return options.catalog ?? CATALOG;
      if (path.startsWith("/api/store/product")) return options.product ?? PRODUCT;
      if (path === "/api/store/install-url") return SIGNED;
      // 连接商城的四条路由：默认匿名模式（页面隐藏连接条，安装照旧）。
      if (path === "/api/store/auth/status") {
        return (
          options.authStatus ?? {
            mode: "anonymous",
            connected: false,
            account: null,
            expiresAt: null,
          }
        );
      }
      if (path === "/api/store/auth/start") return options.authStart ?? AUTH_START;
      if (path === "/api/store/auth/poll") return options.authPoll ?? { status: "pending" };
      if (path === "/api/store/auth/disconnect") return { connected: false, revoked: true };
      throw new Error(`unexpected ${path}`);
    },
    toast: (input) => toasts.push(input),
    navigate: async (path: string) => {
      navigations.push(path);
    },
  };
  // `locale` is a real bridge member; leaving it undefined models a Host that omits it.
  if ("locale" in options) bridge.locale = options.locale as string;
  if (options.install !== false) {
    bridge.installExtension = async (request: HostInstallRequest) => {
      installCalls.push(request);
      if (options.installImpl) return options.installImpl(request);
      return RESULT;
    };
  }
  // 默认没有新方法：绝大多数既有用例因此仍然走「旧宿主只暂存」的路径。
  if (options.enable) {
    bridge.installAndEnableExtension = async (request: HostInstallRequest) => {
      enableCalls.push(request);
      if (options.enableImpl) return options.enableImpl(request);
      return { ...RESULT, outcome: "enabled" };
    };
  }
  return bridge;
}

function render(bridge: FakeBridge) {
  const documentShim = installDom();
  const target = documentShim.createElement("div");
  const cleanup = mount(target, bridge);
  return { document: documentShim, target, cleanup };
}

/**
 * 打开第一张卡的详情。卡片是 `<button>`：真实浏览器点击会先聚焦它，替身不模拟这一步，
 * 所以这里显式 `focus()` —— 「关闭后归还焦点」正是靠它才能断言到 activeElement。
 */
async function openFirstCard(bridge: FakeBridge) {
  const context = render(bridge);
  await flush();
  const card = context.target.querySelector('[data-slug="markdown"]') as any;
  if (!card) throw new Error("catalog card was not rendered");
  card.focus();
  card.dispatchEvent({ type: "click" });
  await flush();
  return { ...context, card };
}

/** 详情弹窗挂在 `document.body` 上：详情断言一律从这里取 HTML。 */
function dialogHTML(context: { document: any }): string {
  return toHTML(context.document.body);
}

/** 弹窗里的控件不在 `target` 下，点击要落到 `document.body`。 */
function dialogClick(context: { document: any }, selector: string, type = "click") {
  return click(context.document.body, selector, type);
}

function click(target: any, selector: string, type = "click") {
  const node = target.querySelector(selector);
  node?.dispatchEvent({ type });
  return node;
}

beforeEach(() => {
  installDom();
});

describe("request building", () => {
  test("catalog path carries the platform escape hatch and only the filters that are set", () => {
    // 架构不再由人挑：目录恒要全部平台，产品不因为异架构消失，判决画在卡片上。
    expect(
      buildCatalogPath({ query: "", channel: "stable", category: "", cursor: null, compatMode: "auto" }),
    ).toBe("/api/store/catalog?channel=stable&platform=all");
    // 「含预发布」 must not send channel=beta: absent means both channels in the store API.
    expect(
      buildCatalogPath({ query: "", channel: "all", category: "", cursor: null, compatMode: "auto" }),
    ).toBe("/api/store/catalog?platform=all");
    expect(
      buildCatalogPath({
        query: "  mark down  ",
        channel: "all",
        category: "content",
        cursor: "c1",
        compatMode: "auto",
      }),
    ).toBe("/api/store/catalog?platform=all&q=mark+down&category=content&cursor=c1");
  });

  test("auto omits compat; an explicit mode is always sent", () => {
    const base = { query: "", channel: "stable" as const, category: "", cursor: null };
    // auto：交给商城按宿主决定（开发版默认显示全部，发行版默认只看可安装）。
    expect(buildCatalogPath({ ...base, compatMode: "auto" })).toBe(
      "/api/store/catalog?channel=stable&platform=all",
    );
    // 显式 compatible 必须发出去：服务端默认值现在是宿主相关的，省略会被解释成另一个口径。
    expect(buildCatalogPath({ ...base, compatMode: "compatible" })).toBe(
      "/api/store/catalog?compat=compatible&channel=stable&platform=all",
    );
    expect(buildCatalogPath({ ...base, compatMode: "all" })).toBe(
      "/api/store/catalog?compat=all&channel=stable&platform=all",
    );
    expect(
      buildCatalogPath({
        query: "mark down",
        channel: "all",
        category: "content",
        cursor: "c1",
        compatMode: "all",
      }),
    ).toBe("/api/store/catalog?compat=all&platform=all&q=mark+down&category=content&cursor=c1");
  });

  test("product path encodes the slug", () => {
    expect(buildProductPath("demo/odd slug")).toBe("/api/store/product?slug=demo%2Fodd%20slug");
  });

  test("install-url body and install request are the exact contract objects", () => {
    expect(buildInstallUrlBody({ slug: "markdown", version: "1.4.2", os: "linux", arch: "amd64" })).toEqual({
      slug: "markdown",
      version: "1.4.2",
      os: "linux",
      arch: "amd64",
    });

    expect(
      buildInstallRequest({
        signed: SIGNED,
        product: { extensionId: "demo.markdown", kind: "plugin" },
        version: "1.4.2",
      }),
    ).toEqual({
      url: SIGNED.url,
      sha256: SIGNED.sha256,
      expectedExtensionId: "demo.markdown",
      expectedType: "plugin",
      expectedVersion: "1.4.2",
    });
  });
});

describe("applied compatibility", () => {
  const page = (estimated: boolean) => ({
    items: [],
    total: 0,
    compatibility: { status: "compatible" as const, estimated },
  });

  test("the response echo wins over anything the page could infer", () => {
    // 开发版宿主显式过滤时服务端回显 compatible：它就是 compatible。
    expect(resolveAppliedCompat(parseCatalog({ ...page(true), compat: "compatible" }), "auto")).toBe(
      "compatible",
    );
    // 回显与请求不一致时以服务端为准（它才知道这次实际怎么筛的）。
    expect(resolveAppliedCompat(parseCatalog({ ...page(false), compat: "all" }), "compatible")).toBe(
      "all",
    );
  });

  test("a missing echo is inferred only for auto: a dev host shows everything", () => {
    expect(resolveAppliedCompat(parseCatalog(page(true)), "auto")).toBe("all");
    expect(resolveAppliedCompat(parseCatalog(page(false)), "auto")).toBe("compatible");
  });

  test("an explicit request is never overruled by the estimate", () => {
    // 显式 compatible 在开发版宿主上也会真的过滤：推断回 all 会把开关状态改错。
    expect(resolveAppliedCompat(parseCatalog(page(true)), "compatible")).toBe("compatible");
    expect(resolveAppliedCompat(parseCatalog(page(false)), "all")).toBe("all");
  });
});

describe("failure mapping", () => {
  test("every stable failure code has Chinese copy", () => {
    expect(INSTALL_FAILURE_TEXT).toEqual({
      install_permission_denied: "没有安装权限",
      install_cancelled: "已取消（离开页面会中断安装）",
      install_in_progress: "已有安装在进行",
      install_invalid_request: "请求无效",
      install_failed: "安装失败",
      "extension.expected_mismatch": "包与目录声明的身份不一致",
    });
  });

  test("the en-US table covers the same codes without claiming success", () => {
    expect(Object.keys(INSTALL_FAILURE_TEXT_EN).sort()).toEqual(Object.keys(INSTALL_FAILURE_TEXT).sort());
    for (const value of Object.values(INSTALL_FAILURE_TEXT_EN)) {
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value.toLowerCase()).not.toContain("installed");
    }
  });

  test("maps a bridge rejection that only carries error.code", () => {
    for (const code of Object.keys(INSTALL_FAILURE_TEXT)) {
      const error = new Error(code) as Error & { code: string };
      error.code = code;
      expect(installFailureText(error)).toBe(INSTALL_FAILURE_TEXT[code]);
    }
  });

  test("maps the Host envelope where the reason sits inside data", () => {
    const mismatch = {
      code: 422,
      message: "extension.expected_mismatch",
      data: { reason: "extension.expected_mismatch" },
    };
    expect(installFailureText(mismatch)).toBe("包与目录声明的身份不一致");
    expect(installFailureText(mismatch, createCopy("en-US"))).toBe(
      "The package does not match the declared identity",
    );
  });

  test("unknown codes keep 安装失败 plus the raw code", () => {
    expect(installFailureText({ code: "install_failed" })).toBe("安装失败");
    expect(installFailureText({ code: "weird.code" })).toBe("安装失败（weird.code）");
    expect(installFailureText({ code: "weird.code" }, createCopy("en-US"))).toBe(
      "Install failed (weird.code)",
    );
    expect(installFailureText({ status: 500 }, createCopy("en-US"))).toBe("Install failed (HTTP 500)");
  });

  test("not_configured is recognised from status, code, or message", () => {
    expect(classifyFailure({ status: 503 }).kind).toBe("not_configured");
    expect(classifyFailure({ data: { code: "not_configured" } }).kind).toBe("not_configured");
    expect(classifyFailure(new Error("upstream not_configured")).kind).toBe("not_configured");
    const failed = classifyFailure({ status: 502, data: { message: "bad gateway" } });
    expect(failed.kind).toBe("failed");
    expect(failed.detail).toBe("bad gateway");
  });
});

describe("payload parsing and view mapping", () => {
  test("accepts both the raw plugin body and a host envelope", () => {
    const raw = parseCatalog(CATALOG);
    const wrapped = parseCatalog({ data: CATALOG });
    expect(raw.total).toBe(2);
    expect(wrapped.items.length).toBe(2);
    expect(parseProduct({ data: PRODUCT }).extensionId).toBe("demo.markdown");
    expect(parseProduct({ data: PRODUCT }).readme?.html).toBe(README.html);
    expect(parseInstallUrl({ data: SIGNED }).url).toBe(SIGNED.url);
  });

  test("drops unusable items instead of throwing", () => {
    const parsed = parseCatalog({
      items: [{ slug: "", name: "x" }, { slug: "ok", name: "OK" }, null],
      total: 3,
      compatibility: { status: "compatible", estimated: false },
    });
    expect(parsed.items.map((item) => item.slug)).toEqual(["ok"]);
    expect(parsed.total).toBe(3);
    expect(parsed.nextCursor).toBeNull();
  });

  test("readme keeps the rendered HTML and collapses unusable shapes to null", () => {
    expect(parseProduct(PRODUCT).readme).toEqual(README);
    // The store returns null until it has read the README; the theme fixture models that.
    expect(parseProduct(THEME_PRODUCT).readme).toBeNull();

    const unusable = [
      undefined,
      null,
      {},
      { html: "   " },
      // html without the GitHub source URL is not a usable README.
      { html: "<p>x</p>" },
      { html: "<p>x</p>", sourceUrl: "https://github.com/example/demo/blob/main/README.md" },
      { html: "<p>x</p>", sourceUrl: "https://github.com/example/demo", fetchedAt: "  " },
      { html: 42, sourceUrl: "https://github.com/example/demo", fetchedAt: "2026-10-24T10:00:00Z" },
      "README",
      ["<p>x</p>"],
    ];
    for (const value of unusable) {
      expect(parseProduct({ product: { ...PRODUCT.product, readme: value } }).readme).toBeNull();
    }
  });

  test("readme tolerates a missing sha or byteSize and ignores wrong types", () => {
    const parsed = parseProduct({
      product: {
        ...PRODUCT.product,
        readme: {
          html: "<p>README</p>",
          sourceUrl: "https://github.com/example/demo/blob/main/README.md",
          fetchedAt: "2026-10-24T10:00:00Z",
        },
      },
    });
    expect(parsed.readme).toEqual({
      html: "<p>README</p>",
      sourceUrl: "https://github.com/example/demo/blob/main/README.md",
      sha: null,
      fetchedAt: "2026-10-24T10:00:00Z",
      byteSize: null,
    });

    const wrongTypes = parseProduct({
      product: { ...PRODUCT.product, readme: { ...README, sha: 42, byteSize: "2048" } },
    });
    expect(wrongTypes.readme).toEqual({ ...README, sha: null, byteSize: null });
  });

  test("view fields: labels, platform wildcard, digest prefix, compatibility note", () => {
    const item = toCatalogItemView(parseCatalog(CATALOG).items[1]!);
    expect(item.kindLabel).toBe("主题");
    expect(item.platformLabels).toEqual(["任意平台"]);
    expect(item.compatibility).toEqual({ label: "兼容", tone: "ok" });
    // 无判决就没有徽标：未知状态只能由页级说明表达。
    expect(compatibilityView({ status: "unknown", estimated: false })).toBeNull();
    expect(compatibilityView({ status: "unknown", estimated: true })).toBeNull();
    // 开发版是宿主属性，不是判决：徽标只放 status，estimated 不再挡在它前面。
    expect(compatibilityView({ status: "compatible", estimated: true })).toEqual({
      label: "兼容",
      tone: "ok",
    });
    expect(compatibilityView({ status: "incompatible", estimated: true })).toEqual({
      label: "不兼容",
      tone: "bad",
    });
    expect(compatibilityView({ status: "incompatible", estimated: false })).toEqual({
      label: "不兼容",
      tone: "bad",
    });
    expect(
      compatibilityNote({ status: "unknown", estimated: false }, createCopy("zh-CN")),
    ).toContain("没有给出可用的版本号");
    expect(constraintChip(">=1.0.0 <2.0.0")).toEqual({
      text: ">=1.0.0 <2.0.0",
      title: ">=1.0.0 <2.0.0",
    });
    expect(constraintChip("")).toBeNull();
    expect(platformLabel({ os: "any", arch: "any" })).toBe("任意平台");
    expect(digestPrefix("9f2c1b7d4e5a6c8d0e1f2a3b")).toBe("9f2c1b7d4e5a");
    expect(digestPrefix("9f2c1b7d4e5a6c8d0e1f2a3b").length).toBe(12);
    expect(toProductView(parseProduct(PRODUCT)).readme?.sourceUrl).toBe(README.sourceUrl);
    expect(toProductView(parseProduct(THEME_PRODUCT)).readme).toBeNull();
  });

  test("only published releases with assets are installable", () => {
    const view = toProductView(parseProduct(PRODUCT));
    expect(view.releases.map((release) => [release.version, release.installable])).toEqual([
      ["1.4.2", true],
      ["1.5.0-beta.1", true],
      ["1.3.0", false],
    ]);
    expect(view.releases[0]!.digestPrefix).toBe("9f2c1b7d4e5a");
    expect(view.releases[2]!.statusLabel).toBe("已撤回");
    expect(view.releases[0]!.platforms.map((platform) => platform.label)).toEqual([
      "linux/amd64",
      "darwin/arm64",
    ]);
  });
});

describe("installed markers", () => {
  test("installed and update labels are built from the host inventory", () => {
    const dto = parseCatalog(installedCatalog()).items[0]!;
    expect(dto.installed).toEqual({ version: "1.2.0", status: "enabled" });
    expect(dto.updateAvailable).toBe(true);
    expect(toCatalogItemView(dto).installed).toEqual({
      version: "1.2.0",
      versionLabel: "已安装 v1.2.0",
      updateLabel: "可更新至 v1.4.2",
      status: "enabled",
      statusNote: null,
    });
  });

  test("no installed entry means no label, even when the store flags an update", () => {
    expect(
      installedView({ installed: null, latestVersion: "1.4.2", updateAvailable: true }),
    ).toBeNull();
  });

  test("updateAvailable false keeps the installed version and drops the update label", () => {
    const view = installedView({
      installed: { version: "1.4.2", status: "enabled" },
      latestVersion: "1.4.2",
      updateAvailable: false,
    });
    expect(view?.versionLabel).toBe("已安装 v1.4.2");
    expect(view?.updateLabel).toBeNull();
  });

  test("a missing latestVersion cannot produce an update label", () => {
    const view = installedView({
      installed: { version: "1.0.0", status: "enabled" },
      latestVersion: "  ",
      updateAvailable: true,
    });
    expect(view?.updateLabel).toBeNull();
  });

  test("host status only becomes a secondary note, and enabled says nothing", () => {
    expect(installedStatusNote("enabled")).toBeNull();
    expect(installedStatusNote("")).toBeNull();
    expect(installedStatusNote("disabled")).toBe("已在宿主停用");
    expect(installedStatusNote("installed")).toBe("已装，尚未启用");
    expect(installedStatusNote("quarantined")).toBe("宿主状态：quarantined");
    expect(installedStatusNote("disabled", createCopy("en-US"))).toBe("Disabled in this host");
  });
});

describe("frozen contract tolerance", () => {
  test("an older backend without the new fields parses to null/false", () => {
    const item = parseCatalog({ items: [{ slug: "x", name: "X" }], total: 1 }).items[0]!;
    expect(item.socialImageUrl).toBeNull();
    expect(item.installed).toBeNull();
    expect(item.updateAvailable).toBe(false);
    expect(toCatalogItemView(item).installed).toBeNull();

    const product = parseProduct({ product: { slug: "x", name: "X", releases: [] } });
    expect(product.socialImageUrl).toBeNull();
    expect(product.installed).toBeNull();
    expect(product.updateAvailable).toBe(false);
    expect(toProductView(product).installed).toBeNull();
  });

  test("a missing or unknown compat echo collapses to null", () => {
    const base = {
      items: [],
      total: 0,
      compatibility: { status: "unknown" as const, estimated: false },
    };
    // 老服务端没有 compat 字段：页面按「没回显」处理，不编一个值出来。
    expect(parseCatalog(base).compat).toBeNull();
    expect(parseCatalog({ ...base, compat: "all" }).compat).toBe("all");
    expect(parseCatalog({ ...base, compat: "compatible" }).compat).toBe("compatible");
    expect(parseCatalog({ ...base, compat: "strict" }).compat).toBeNull();
    expect(parseCatalog({ ...base, compat: 42 }).compat).toBeNull();
  });

  test("wrongly-typed fields collapse instead of leaking into the view", () => {
    const [item] = parseCatalog({
      items: [
        {
          slug: "x",
          name: "X",
          socialImageUrl: 42,
          installed: "yes",
          updateAvailable: "true",
          iconUrl: "data:image/png;base64,AAAA",
        },
      ],
      total: 1,
    }).items;
    expect(item!.socialImageUrl).toBeNull();
    expect(item!.installed).toBeNull();
    expect(item!.updateAvailable).toBe(false);
    // 只放行 http(s)：data:/javascript: 不该进 <img src>。
    expect(item!.iconUrl).toBeNull();
  });

  test("relative asset paths from a misconfigured store are ignored", () => {
    const [item] = parseCatalog({
      items: [{ slug: "x", name: "X", socialImageUrl: "/api/assets/abc", iconUrl: "//cdn.example.com/i.png" }],
      total: 1,
    }).items;
    expect(item!.socialImageUrl).toBeNull();
    expect(item!.iconUrl).toBeNull();
  });

  test("an installed entry without a version is treated as not installed", () => {
    const [item] = parseCatalog({
      items: [{ slug: "x", name: "X", installed: { status: "enabled" }, updateAvailable: true }],
      total: 1,
    }).items;
    expect(item!.installed).toBeNull();
    expect(toCatalogItemView(item!).installed).toBeNull();
  });

  test("a usable installed entry survives with an empty status", () => {
    const [item] = parseCatalog({
      items: [{ slug: "x", name: "X", installed: { version: "2.0.0" } }],
      total: 1,
    }).items;
    expect(item!.installed).toEqual({ version: "2.0.0", status: "" });
    expect(installedView(item!)?.statusNote).toBeNull();
  });
});

describe("mount", () => {
  test("exports apiVersion 1 and renders the catalog with real request params", async () => {
    expect(apiVersion).toBe(1);
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();

    expect(bridge.requests[0]).toEqual({ path: "/api/store/catalog?channel=stable&platform=all", options: undefined });
    expect(target.querySelector('[data-role="count"]')!.textContent).toBe("共 2 个结果");
    expect(target.querySelectorAll(".sfstore__card").length).toBe(2);
    expect(target.querySelector('[data-role="stale"]')!.textContent).toContain("数据更新于");
    const html = toHTML(target);
    // 无判决不再逐行盖戳：未知状态由页级的一句说明表达。
    expect(html).not.toContain("未校验");
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "没有给出可用的版本号",
    );
    // 开发版属性不再上卡片：徽标只放判决，宿主口径由页级那一句说。卡片固定 5 枚槽位，
    // 这一项的 5 枚刚好装下（类型 / 版本 / 两个平台 / 清单约束），没有折行。
    const meta = target.querySelectorAll(".sfstore__card-meta")[0]!;
    expect(meta.children.length).toBe(5);
    const constraint = meta.children.at(-1) as any;
    expect(constraint.textContent).toBe("sforum >=1.0.0 <2.0.0");
    expect(constraint.title).toBe(">=1.0.0 <2.0.0");
    expect(html).not.toContain("按开发版估算");
    expect(html).not.toContain("<img");
  });

  test("a card with more than five facts folds the extras into +N with a full title", async () => {
    // 类型 / 版本 / 已安装 / 两个平台 / 清单约束 / 兼容 = 7 枚：前 4 枚直出，余下折成 +3。
    const dense = {
      ...CATALOG,
      compatibility: { status: "compatible" as const, estimated: true },
      items: CATALOG.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              compatibility: { status: "compatible" as const, estimated: true },
              installed: { version: "1.2.0", status: "enabled" },
              updateAvailable: true,
            }
          : item,
      ),
    };
    const bridge = fakeBridge({ catalog: dense });
    const { target } = render(bridge);
    await flush();

    const meta = target.querySelectorAll(".sfstore__card-meta")[0]!;
    expect(meta.children.length).toBe(5);
    const folded = meta.children.at(-1) as any;
    expect(folded.textContent).toBe("+3");
    // 折起来的事实仍可悬停读到：约束与判决都在 title 里。
    expect(folded.title).toContain("sforum >=1.0.0 <2.0.0");
    expect(folded.title).toContain("兼容");
  });

  test("switching the channel to 含预发布 drops the channel param", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    const select = target.querySelector('[data-role="channel"]') as any;
    select.value = "all";
    select.dispatchEvent({ type: "change" });
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?platform=all");
  });

  test("load more appends the next page and dedupes by slug", async () => {
    const bridge = fakeBridge();
    bridge.request = (async (requestPath: string, options?: Record<string, unknown>) => {
      bridge.requests.push({ path: requestPath, options });
      if (requestPath.includes("cursor=cursor-2")) {
        // 第二页故意重复第一页的 aurora：追加必须按 slug 去重。
        return {
          ...CATALOG,
          items: [{ ...CATALOG.items[1] }, { slug: "extra", name: "Extra 插件", kind: "plugin" }],
          total: 3,
          nextCursor: null,
        };
      }
      return CATALOG;
    }) as PageBridge["request"];

    const { target } = render(bridge);
    await flush();
    expect(target.querySelectorAll(".sfstore__card").length).toBe(2);

    click(target, '[data-role="more"]');
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?channel=stable&platform=all&cursor=cursor-2");
    const slugs = target
      .querySelectorAll(".sfstore__card")
      .map((card) => card.getAttribute("data-slug"));
    expect(slugs).toEqual(["markdown", "aurora", "extra"]);
    // 游标耗尽：按钮与错误位一起收起。
    expect((target.querySelector('[data-role="more-wrap"]') as any).hidden).toBe(true);
  });

  test("changing a filter resets paging to the first page", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    click(target, '[data-role="more"]');
    await flush();
    expect(bridge.requests.at(-1)!.path).toContain("cursor=cursor-2");

    const select = target.querySelector('[data-role="channel"]') as any;
    select.value = "all";
    select.dispatchEvent({ type: "change" });
    await flush();
    // 新口径从第一页重来：不把旧结果集的游标带进新过滤。
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?platform=all");

    click(target, '[data-role="more"]');
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?platform=all&cursor=cursor-2");
  });

  test("card click loads the product into the dialog: README, versions, constraint, digest, selectors", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/product?slug=markdown");

    // 详情只住在 body 层的弹窗里，页面根不再重复一份。
    expect(context.target.querySelector(".sforum-store-readme")).toBeNull();
    const html = dialogHTML(context);
    expect(html).toContain("&gt;=1.0.0 &lt;2.0.0");
    expect(html).toContain("9f2c1b7d4e5");
    expect(html).toContain("host.api · net.outbound");

    // README: the store's sanitised HTML is injected verbatim into its own container.
    expect(html).toContain("README");
    expect(html).toContain('class="sforum-store-readme"');
    expect(html).toContain("<h1>Markdown 增强</h1>");
    expect(html).toContain("<pre><code>bun test</code></pre>");
    expect(context.document.body.querySelector(".sforum-store-readme")!.innerHTML).toBe(README.html);

    // 「在 GitHub 查看」 opens the blob page in a new tab with a bare referrer.
    const source = context.document.body.querySelector(".sfstore__link") as any;
    expect(source.href).toBe(README.sourceUrl);
    expect(source.target).toBe("_blank");
    expect(source.rel).toBe("noreferrer noopener");
    expect(source.textContent).toBe("在 GitHub 查看");

    const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
    expect(versionSelect.value).toBe("1.4.2");
    // 平台不再有下拉：架构由宿主 target 自动决定，页面只留版本选择。
    expect(context.document.body.querySelector('[data-action="platform"]')).toBeNull();
  });

  test("a product without a README renders the placeholder, not an empty container", async () => {
    const bridge = fakeBridge({ product: THEME_PRODUCT });
    const context = render(bridge);
    await flush();
    context.target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();

    const html = dialogHTML(context);
    expect(html).toContain("README");
    expect(html).toContain("这个产品还没有可展示的 README。");
    expect(html).not.toContain("sforum-store-readme");
    expect(context.document.body.querySelector(".sforum-store-readme")).toBeNull();
    expect(context.document.body.querySelector(".sfstore__link")).toBeNull();
  });

  test("install posts install-url then calls installExtension with the exact object", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const installUrlCall = bridge.requests.at(-1)!;
    expect(installUrlCall.path).toBe("/api/store/install-url");
    expect(installUrlCall.options).toEqual({
      method: "POST",
      body: { slug: "markdown", version: "1.4.2", os: "linux", arch: "amd64" },
    });
    expect(bridge.installCalls).toHaveLength(1);
    expect(bridge.installCalls[0]).toEqual({
      url: SIGNED.url,
      sha256: SIGNED.sha256,
      expectedExtensionId: "demo.markdown",
      expectedType: "plugin",
      expectedVersion: "1.4.2",
    });

    const html = dialogHTML(context);
    expect(html).toContain("已暂存");
    expect(html).toContain("启用与信任在 core 完成");
    expect(html).toContain("demo.markdown");
    expect(html).toContain("1.4.2");
    // 回执给出制品摘要全值：管理员要能拿它对上商城签名里的 sha256。
    const stagedReceipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(stagedReceipt.textContent).toContain(SIGNED.sha256);
    expect(
      stagedReceipt.querySelectorAll(".sfstore__mono").map((node: any) => node.textContent),
    ).toContain(SIGNED.sha256);
    expect(bridge.toasts).toHaveLength(1);
    expect(bridge.toasts[0]).toEqual({
      title: "已暂存",
      description: "启用与信任在 core 完成",
      kind: "success",
    });

    dialogClick(context, '[data-action="open-core"]');
    await flush();
    expect(bridge.navigations).toEqual([CORE_PLUGINS_PATH]);
  });

  test("theme install navigates to the themes page", async () => {
    const bridge = fakeBridge({
      installImpl: async () => ({
        extensionId: "demo.aurora",
        version: "0.9.0",
        type: "theme",
        packageDigest: "b".repeat(64),
        upgraded: false,
        requiresTrust: false,
      }),
    });
    const originalRequest = bridge.request;
    bridge.request = (async (path: string, options?: Record<string, unknown>) => {
      if (path.startsWith("/api/store/product")) return THEME_PRODUCT;
      if (path === "/api/store/install-url") return SIGNED;
      return originalRequest(path, options);
    }) as PageBridge["request"];

    const context = render(bridge);
    await flush();
    context.target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();
    dialogClick(context, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls[0]!.expectedType).toBe("theme");
    dialogClick(context, '[data-action="open-core"]');
    await flush();
    expect(bridge.navigations).toEqual([CORE_THEMES_PATH]);
  });

  test("a rejected install maps the code to Chinese copy and keeps the page usable", async () => {
    const bridge = fakeBridge({
      installImpl: async () => {
        const error = new Error("install_permission_denied") as Error & { code: string };
        error.code = "install_permission_denied";
        throw error;
      },
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();
    const html = dialogHTML(context);
    expect(html).toContain("没有安装权限");
    expect(bridge.toasts.at(-1)).toEqual({ title: "没有安装权限", kind: "error" });
    expect((context.document.body.querySelector('[data-action="install"]') as any).disabled).toBe(false);
  });

  test("single flight: a second click while pending is ignored and explained", async () => {
    let release: (value: HostInstallResult) => void = () => {};
    const pending = new Promise<HostInstallResult>((resolve) => {
      release = resolve;
    });
    const bridge = fakeBridge({ installImpl: () => pending });
    const context = await openFirstCard(bridge);

    dialogClick(context, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls).toHaveLength(1);
    expect(dialogHTML(context)).toContain("安装期间不要关闭页面");

    dialogClick(context, '[data-action="install"]');
    await flush();
    // 第二次点击不产生第二个请求：安装条仍是「安装中…」，说明走 toast。
    expect(bridge.installCalls).toHaveLength(1);
    expect(bridge.toasts.at(-1)).toEqual({
      title: "已有安装在进行",
      description: "等当前安装结束后再试",
      kind: "error",
    });
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "安装中…",
    );

    release(RESULT);
    await flush();
    expect(dialogHTML(context)).toContain("已暂存");
  });

  test("without bridge.installExtension the page explains the limit and offers the signed URL", async () => {
    const bridge = fakeBridge({ install: false });
    const context = await openFirstCard(bridge);
    const html = dialogHTML(context);
    expect(html).toContain("当前宿主不支持页面内安装");
    expect(context.document.body.querySelector('[data-action="install"]')).toBeNull();
    expect(context.document.body.querySelector('[data-action="sign"]')).not.toBeNull();

    dialogClick(context, '[data-action="sign"]');
    await flush();
    const signedHtml = dialogHTML(context);
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/install-url");
    expect(signedHtml).toContain("链接 30 分钟内有效");
    expect(signedHtml).toContain("在 core 的扩展安装页粘贴");
    expect(signedHtml).toContain(SIGNED.url);

    dialogClick(context, '[data-action="open-core-install"]');
    await flush();
    expect(bridge.navigations).toEqual([CORE_INSTALL_PATH]);
  });

  test("503 not_configured renders the calm setup state without a retry loop", async () => {
    const bridge = fakeBridge({ configured: false });
    const { target } = render(bridge);
    await flush();
    await flush();
    const html = toHTML(target);
    expect(html).toContain("还没配置商城地址");
    expect(html).toContain("到 应用商城 设置里填写商城地址");
    // 两次探测各一次：目录 + 连接状态。没有重试循环，也没有第三个请求。
    expect(bridge.requests.length).toBe(2);
  });

  test("cleanup removes the nodes it added and stops listening", async () => {
    const bridge = fakeBridge();
    const { target, document: doc, cleanup } = await openFirstCard(bridge);
    expect(target.children.length).toBe(1);
    // 弹窗挂在 body 上：清理必须把 overlay 一起带走，不能在 body 里留尸体。
    expect(doc.body.children.length).toBe(1);
    const card = target.querySelector('[data-slug="markdown"]')!;
    const before = bridge.requests.length;

    cleanup();
    expect(target.children.length).toBe(0);
    expect(doc.body.children.length).toBe(0);

    card.dispatchEvent({ type: "click" });
    await flush();
    expect(bridge.requests.length).toBe(before);
  });

  test("cleanup clears a pending search debounce", async () => {
    const bridge = fakeBridge();
    const { target, cleanup } = render(bridge);
    await flush();
    const search = target.querySelector('[data-role="search"]') as any;
    const before = bridge.requests.length;
    search.value = "mark";
    search.dispatchEvent({ type: "input" });
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridge.requests.length).toBe(before);
  });

  test("the staging result never claims an install, an update or a verified build", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();
    // 安装流程的结论只看这一块。「已安装 v…」是宿主已装清单的事实徽标（见 installed 标记），
    // 不是本页把包装上了，所以禁语检查锁定在暂存结果上，而不是整页文本。
    const staged = context.document.body.querySelector(".sfstore__receipt")!;
    for (const banned of ["已安装", "已更新", "已验证构建", "自动升级"]) {
      expect(staged.textContent.includes(banned)).toBe(false);
    }
  });
});

describe("install and enable", () => {
  test("a host with installAndEnableExtension enables the package and says so", async () => {
    const bridge = fakeBridge({ enable: true });
    const context = await openFirstCard(bridge);

    // 点之前就说清「装完由宿主启用」，按钮也如实写成「安装并启用」。
    expect(dialogHTML(context)).toContain("安装后会自动启用");
    const before = context.document.body.querySelector('[data-action="install"]') as any;
    expect(before.textContent).toBe("安装并启用");

    dialogClick(context, '[data-action="install"]');
    await flush();

    // 新方法只调一次，旧的暂存方法完全没被碰。
    expect(bridge.enableCalls).toHaveLength(1);
    expect(bridge.installCalls).toHaveLength(0);
    expect(bridge.enableCalls[0]).toEqual({
      url: SIGNED.url,
      sha256: SIGNED.sha256,
      expectedExtensionId: "demo.markdown",
      expectedType: "plugin",
      expectedVersion: "1.4.2",
    });

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.getAttribute("data-outcome")).toBe("enabled");
    expect(receipt.textContent).toContain("已启用");
    expect(receipt.textContent).toContain("宿主已启用这个扩展");
    // 已经在跑：不能再劝人去 core 完成启用/信任。
    expect(receipt.textContent).not.toContain("启用与信任在 core 完成");
    expect(receipt.textContent).not.toContain("去 core 完成升级");
    expect(receipt.textContent).toContain(SIGNED.sha256);

    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "已启用 · v1.4.2",
    );
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("已启用");
    expect(action.disabled).toBe(true);
    expect(bridge.toasts.at(-1)).toEqual({
      title: "已启用",
      description: "宿主已启用这个扩展，不用再去 core。",
      kind: "success",
    });
  });

  test("outcome upgraded reports an upgrade, never a fresh install", async () => {
    const bridge = fakeBridge({
      enable: true,
      enableImpl: async () => ({ ...RESULT, upgraded: true, outcome: "upgraded" }),
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.getAttribute("data-outcome")).toBe("upgraded");
    expect(receipt.textContent).toContain("已升级");
    expect(receipt.textContent).toContain("宿主已把已启用的扩展升级到这个版本");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "已升级 · v1.4.2",
    );
    expect((context.document.body.querySelector('[data-action="install"]') as any).textContent).toBe(
      "已升级",
    );
  });

  test("outcome staged from a new host still says staged and points at core", async () => {
    const bridge = fakeBridge({
      enable: true,
      enableImpl: async () => ({ ...RESULT, outcome: "staged" }),
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.getAttribute("data-outcome")).toBe("staged");
    expect(receipt.textContent).toContain("已暂存");
    expect(receipt.textContent).toContain("启用与信任在 core 完成");
    expect(receipt.textContent).toContain("该包带可执行后端");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "已暂存 · v1.4.2",
    );
  });

  test("an unknown outcome is treated as staged, never as enabled", async () => {
    const bridge = fakeBridge({
      enable: true,
      // 跨 bridge 的值不可信：编造/未知的 outcome 只能退化成「已暂存」。
      enableImpl: async () =>
        ({ ...RESULT, outcome: "auto-magically-running" }) as unknown as HostInstallEnableResult,
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.getAttribute("data-outcome")).toBe("staged");
    expect(receipt.textContent).toContain("已暂存");
    expect(dialogHTML(context)).not.toContain("已启用");
  });

  test("an old host without the new method falls back to installExtension and stays staged", async () => {
    const bridge = fakeBridge();
    expect(bridge.installAndEnableExtension).toBeUndefined();
    const context = await openFirstCard(bridge);

    // 旧宿主不该看到「安装并启用」，也不该看到自动启用的提示。
    expect((context.document.body.querySelector('[data-action="install"]') as any).textContent).toBe(
      "安装到论坛",
    );
    expect(dialogHTML(context)).not.toContain("安装后会自动启用");

    dialogClick(context, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls).toHaveLength(1);
    expect(bridge.enableCalls).toHaveLength(0);
    expect(context.document.body.querySelector(".sfstore__receipt")!.textContent).toContain("已暂存");
    expect(bridge.toasts.at(-1)).toEqual({
      title: "已暂存",
      description: "启用与信任在 core 完成",
      kind: "success",
    });
  });

  test("an upgrade on an enabling host says update and enable, not update only", async () => {
    // 已装 1.2.0、可升到 1.4.2：门禁是 upgrade，文案必须把「启用」也带上。
    const bridge = fakeBridge({
      enable: true,
      product: gatedProduct("1.2.0", { "1.4.2": "newer", "1.5.0-beta.1": "newer" }),
    });
    const context = await openFirstCard(bridge);
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("更新并启用 v1.4.2");

    // 旧宿主同一份夹具只写「更新」，不承诺启用。
    const legacyBridge = fakeBridge({
      product: gatedProduct("1.2.0", { "1.4.2": "newer", "1.5.0-beta.1": "newer" }),
    });
    const legacyContext = await openFirstCard(legacyBridge);
    expect(
      (legacyContext.document.body.querySelector('[data-action="install"]') as any).textContent,
    ).toBe("更新到 v1.4.2");
  });

  test("pending never rewrites the overlay z-index: stacking belongs to the host", async () => {
    let release: (value: HostInstallEnableResult) => void = () => {};
    const pending = new Promise<HostInstallEnableResult>((resolve) => {
      release = resolve;
    });
    const bridge = fakeBridge({ enable: true, enableImpl: () => pending });
    const context = await openFirstCard(bridge);

    dialogClick(context, '[data-action="install"]');
    await flush();

    const overlay = context.document.body.querySelector('[data-role="dialog-overlay"]') as any;
    // 曾经的 hack 会在安装期间把遮罩降到 0；现在层级完全交给宿主（宿主弹窗 z-80）。
    expect(overlay.style.zIndex).toBeUndefined();
    // 关闭按钮仍然禁用：安装没结束不能把进度丢掉。
    expect((context.document.body.querySelector('[data-action="dialog-close"]') as any).disabled).toBe(
      true,
    );

    release({ ...RESULT, outcome: "enabled" });
    await flush();
    expect(overlay.style.zIndex).toBeUndefined();
    expect(dialogHTML(context)).toContain("已启用");
  });

  test("an activate-phase failure says installed-not-enabled and never offers a reinstall", async () => {
    const bridge = fakeBridge({
      enable: true,
      enableImpl: async () => {
        // 宿主在装好之后启用失败：code 仍是 install_failed，但 phase 说明包已在盘上。
        const error = new Error("install_failed") as Error & { code: string; phase: string };
        error.code = "install_failed";
        error.phase = "activate";
        throw error;
      },
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.getAttribute("data-outcome")).toBe("pending-enable");
    expect(receipt.textContent).toContain("已安装，尚未启用");
    expect(receipt.textContent).toContain("不用重新安装");
    // 文案不能退回「安装失败」。
    expect(receipt.textContent).not.toContain("安装失败");

    // 主按钮不再提供整包重装。
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("已安装，尚未启用");
    expect(action.disabled).toBe(true);
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "已安装，尚未启用",
    );

    // 唯一入口是去 core 的扩展页。
    dialogClick(context, '[data-action="open-core"]');
    await flush();
    expect(bridge.navigations).toEqual([CORE_PLUGINS_PATH]);
    expect(bridge.toasts.at(-1)).toEqual({
      title: "已安装，尚未启用",
      description: "包已经装好，启用没成功；去 core 的扩展页启用即可，不用重新安装。",
      kind: "error",
    });
  });

  test("a theme receipt points at the themes page instead of core trust", async () => {
    const bridge = fakeBridge({
      installImpl: async () => ({
        extensionId: "demo.aurora",
        version: "0.9.0",
        type: "theme",
        packageDigest: "b".repeat(64),
        upgraded: false,
        requiresTrust: false,
      }),
    });
    const originalRequest = bridge.request;
    bridge.request = (async (path: string, options?: Record<string, unknown>) => {
      if (path.startsWith("/api/store/product")) return THEME_PRODUCT;
      if (path === "/api/store/install-url") return SIGNED;
      return originalRequest(path, options);
    }) as PageBridge["request"];

    const context = render(bridge);
    await flush();
    context.target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();
    dialogClick(context, '[data-action="install"]');
    await flush();

    const receipt = context.document.body.querySelector(".sfstore__receipt") as any;
    expect(receipt.textContent).toContain("主题装好后要到主题页选择并激活。");
    expect(receipt.textContent).not.toContain("启用与信任在 core 完成");
    const coreButton = receipt.querySelector('[data-action="open-core"]') as any;
    expect(coreButton.textContent).toBe("去主题页激活");
  });

  test("a failed enable keeps the page usable and retry is allowed", async () => {
    const bridge = fakeBridge({
      enable: true,
      enableImpl: async () => {
        const error = new Error("install_failed") as Error & { code: string };
        error.code = "install_failed";
        throw error;
      },
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    // 失败就是失败：不回执、不宣称启用，主按钮重新可用。
    expect(context.document.body.querySelector(".sfstore__receipt")).toBeNull();
    expect(dialogHTML(context)).not.toContain("已启用");
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe("安装并启用");
  });
});

// 焦点陷阱（Tab / Shift+Tab 回绕）在替身里测不了：`focusables()` 依赖 `:not()` 复合选择器，
// 替身的 querySelector 不认，会返回空列表，陷阱自然退化为 no-op。那一条留给浏览器验收，
// 这里不写会假通过的回绕用例。
describe("dialog mechanics", () => {
  test("a card click opens a modal dialog on document.body and marks the page root inert", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);

    const overlay = context.document.body.querySelector('[data-role="dialog-overlay"]') as any;
    expect(overlay).not.toBeNull();
    expect(overlay.parentNode).toBe(context.document.body);
    // 弹窗是详情的唯一渲染位置：页面根里没有第二份。
    expect(context.target.querySelector('[role="dialog"]')).toBeNull();

    const surface = context.document.body.querySelector('[role="dialog"]') as any;
    expect(surface.getAttribute("aria-modal")).toBe("true");
    expect(surface.getAttribute("aria-labelledby")).toBe("sfstore-dialog-title");
    expect(context.document.body.querySelector("#sfstore-dialog-title")!.textContent).toBe(
      "Markdown 增强",
    );
    // 背景根变 inert，键盘与读屏都到不了目录。
    expect(context.target.querySelector('[data-role="root"]')!.getAttribute("inert")).toBe("");
    // 卡片先声明它会开弹窗。
    expect(context.card.getAttribute("aria-haspopup")).toBe("dialog");
    // 三个分区都在，默认落在 README。
    expect(context.document.body.querySelectorAll('[role="tabpanel"]').length).toBe(3);
    expect(
      context.document.body.querySelector('[data-tab="readme"]')!.getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("Escape closes the dialog and gives focus back to the card that opened it", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const tab = context.document.body.querySelector('[data-tab="readme"]') as any;
    // 打开时焦点落在活动 tab 上。
    expect(context.document.activeElement).toBe(tab);

    tab.dispatchEvent({ type: "keydown", key: "Escape" });
    await flush();

    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).toBeNull();
    // 显式归还：不依赖「节点被移除后 activeElement 自动回落」。
    expect(context.document.activeElement).toBe(context.card);
    expect(context.target.querySelector('[data-role="root"]')!.getAttribute("inert")).toBeNull();
  });

  test("only a click on the overlay itself closes; the close button closes too", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const surface = context.document.body.querySelector('[role="dialog"]') as any;

    // 点对话框内部不关闭：事件冒泡到遮罩，但 target 不是遮罩本身。
    surface.dispatchEvent({ type: "click" });
    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).not.toBeNull();

    (context.document.body.querySelector('[data-role="dialog-overlay"]') as any).dispatchEvent({
      type: "click",
    });
    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).toBeNull();

    // 再开一次，用关闭按钮（×）关。
    context.card.dispatchEvent({ type: "click" });
    await flush();
    dialogClick(context, '[data-action="dialog-close"]');
    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).toBeNull();
  });

  test("clicking a tab moves aria-selected and shows exactly one panel", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const readme = context.document.body.querySelector('[data-tab="readme"]') as any;
    const versions = context.document.body.querySelector('[data-tab="versions"]') as any;
    const notes = context.document.body.querySelector('[data-tab="notes"]') as any;

    versions.dispatchEvent({ type: "click" });
    expect(versions.getAttribute("aria-selected")).toBe("true");
    expect(readme.getAttribute("aria-selected")).toBe("false");
    expect(notes.getAttribute("aria-selected")).toBe("false");
    // 只有活动分区留在 tab 序里。
    expect(versions.getAttribute("tabindex")).toBe("0");
    expect(readme.getAttribute("tabindex")).toBe("-1");

    const panels = context.document.body.querySelectorAll('[role="tabpanel"]');
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false, true]);
    expect(context.document.body.querySelector("#sfstore-panel-versions")!.hidden).toBe(false);
  });

  test("←/→ and Home/End move the selected tab and the focus together", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const readme = context.document.body.querySelector('[data-tab="readme"]') as any;
    const versions = context.document.body.querySelector('[data-tab="versions"]') as any;
    const notes = context.document.body.querySelector('[data-tab="notes"]') as any;

    readme.dispatchEvent({ type: "keydown", key: "ArrowRight" });
    expect(versions.getAttribute("aria-selected")).toBe("true");
    expect(context.document.activeElement).toBe(versions);

    versions.dispatchEvent({ type: "keydown", key: "ArrowRight" });
    expect(notes.getAttribute("aria-selected")).toBe("true");

    notes.dispatchEvent({ type: "keydown", key: "ArrowLeft" });
    expect(versions.getAttribute("aria-selected")).toBe("true");

    readme.dispatchEvent({ type: "keydown", key: "End" });
    expect(notes.getAttribute("aria-selected")).toBe("true");
    expect(context.document.activeElement).toBe(notes);

    notes.dispatchEvent({ type: "keydown", key: "Home" });
    expect(readme.getAttribute("aria-selected")).toBe("true");
    expect(context.document.activeElement).toBe(readme);
  });

  test("an install in flight refuses to close", async () => {
    let release: (value: HostInstallResult) => void = () => {};
    const pending = new Promise<HostInstallResult>((resolve) => {
      release = resolve;
    });
    const bridge = fakeBridge({ installImpl: () => pending });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    const closeButton = context.document.body.querySelector('[data-action="dialog-close"]') as any;
    expect(closeButton.disabled).toBe(true);
    // Esc、遮罩点击、关闭按钮三路都被忽略：装到一半不能把进度丢掉。
    (context.document.body.querySelector('[data-tab="readme"]') as any).dispatchEvent({
      type: "keydown",
      key: "Escape",
    });
    (context.document.body.querySelector('[data-role="dialog-overlay"]') as any).dispatchEvent({
      type: "click",
    });
    closeButton.dispatchEvent({ type: "click" });
    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).not.toBeNull();

    release(RESULT);
    await flush();
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toContain(
      "已暂存",
    );
    // 装完之后 Esc 又能关了。
    (context.document.body.querySelector('[data-tab="readme"]') as any).dispatchEvent({
      type: "keydown",
      key: "Escape",
    });
    expect(context.document.body.querySelector('[data-role="dialog-overlay"]')).toBeNull();
  });
});

describe("dialog panels", () => {
  test("the versions panel is a six-column table with the yanked status and digest prefix", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const table = context.document.body.querySelector(".sfstore__table") as any;
    expect(table).not.toBeNull();

    const headers = table.querySelectorAll("th").map((th: any) => th.textContent);
    expect(headers).toEqual(["版本", "频道", "日期", "sforum 约束", "能力", "摘要"]);

    const body = table.querySelector("tbody") as any;
    expect(body.children.length).toBe(3);
    for (const row of body.children) expect(row.children.length).toBe(6);
    // 撤回版本仍留在表里：带状态徽标，没有摘要。
    expect(table.textContent).toContain("已撤回");

    // 摘要列：正文 12 位前缀，title 承载完整 digest（可核对、不撑破列宽）。
    const digestCells = table.querySelectorAll('[data-label="摘要"]');
    const firstDigest = digestCells[0]!.querySelector(".sfstore__mono") as any;
    expect(firstDigest.textContent).toBe(SIGNED.sha256.slice(0, 12));
    expect(firstDigest.title).toBe(SIGNED.sha256);
    // 撤回版本没有摘要，只留破折号。
    expect(digestCells[2]!.textContent).toBe("—");
  });

  const notesProduct = (notes: Record<string, string>) => ({
    product: {
      ...PRODUCT.product,
      releases: PRODUCT.product.releases.map((release) => ({
        ...release,
        notes: notes[release.version] ?? "",
      })),
    },
  });

  test("release notes are newest-first and skip releases without notes", async () => {
    const bridge = fakeBridge({
      product: notesProduct({ "1.4.2": "稳定版说明", "1.5.0-beta.1": "预发布说明" }),
    });
    const context = await openFirstCard(bridge);
    const panel = context.document.body.querySelector("#sfstore-panel-notes") as any;

    const heads = panel
      .querySelectorAll(".sfstore__note-head")
      .map((node: any) => node.textContent.split(" · ")[0]);
    expect(heads).toEqual(["v1.5.0-beta.1", "v1.4.2"]);
    expect(panel.textContent).toContain("预发布说明");
    // 没有说明的 1.3.0 不进列表。
    expect(panel.textContent).not.toContain("1.3.0");
  });

  test("a product without release notes renders the placeholder", async () => {
    const bridge = fakeBridge({ product: THEME_PRODUCT });
    const context = render(bridge);
    await flush();
    context.target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();

    const panel = context.document.body.querySelector("#sfstore-panel-notes") as any;
    expect(panel.textContent).toContain("这个产品还没有更新说明。");
  });

  test("the install bar stays on every tab: install from 版本信息 and keep the tab", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-tab="versions"]');
    expect(
      context.document.body.querySelector('[data-tab="versions"]')!.getAttribute("aria-selected"),
    ).toBe("true");

    dialogClick(context, '[data-action="install"]');
    await flush();

    // 装完仍停在「版本信息」：只有通知槽与安装条重绘，分区与滚动位置不动。
    expect(
      context.document.body.querySelector('[data-tab="versions"]')!.getAttribute("aria-selected"),
    ).toBe("true");
    expect(context.document.body.querySelector("#sfstore-panel-versions")!.hidden).toBe(false);
    expect(context.document.body.querySelector(".sfstore__receipt")!.textContent).toContain("已暂存");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "已暂存 · v1.4.2",
    );
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("已暂存");
    expect(action.disabled).toBe(true);
  });
});

describe("compatibility switch", () => {
  /** 开发版宿主：版本由 git tag 派生，服务端把页级 estimated 标成 true。 */
  const devCatalog = () => ({
    ...CATALOG,
    compatibility: { status: "compatible" as const, estimated: true },
  });

  test("a host without a version hides the switch and keeps the unjudged sentence", async () => {
    const bridge = fakeBridge(); // CATALOG 的页级 compatibility 是 unknown
    const { target } = render(bridge);
    await flush();
    const field = target.querySelector('[data-role="compat-toggle"]') as any;
    expect(field.hidden).toBe(true);
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain("没有给出可用的版本号");
    // 勾选状态始终跟口径走，即使开关藏着。
    expect((target.querySelector(".sfstore__toggle-input") as any).checked).toBe(true);
  });

  test("a verdict shows the switch; switching to 全部 re-queries from page one", async () => {
    const bridge = fakeBridge({ catalog: compatibleCatalog() });
    const { target } = render(bridge);
    await flush();

    const field = target.querySelector('[data-role="compat-toggle"]') as any;
    expect(field.hidden).toBe(false);
    expect(target.querySelector(".sfstore__toggle-text")!.textContent).toBe("只看当前版本可安装");
    // auto：首屏不发送 compat，由商城按宿主决定；发行版宿主默认就是「只看可安装」。
    expect(bridge.requests[0]!.path).toBe("/api/store/catalog?channel=stable&platform=all");
    // 口径说明只陈述「筛过」，不替 core 下「可安装」的结论。
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "已按宿主版本与各版本的 sforumVersion 约束筛选",
    );
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "能否安装以 core 判定为准",
    );

    click(target, '[data-role="more"]');
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?channel=stable&platform=all&cursor=cursor-2");

    const box = target.querySelector(".sfstore__toggle-input") as any;
    box.checked = false;
    box.dispatchEvent({ type: "change" });
    await flush();
    // 回到第一页：游标清空，不把旧结果集的 cursor 带进新的过滤口径。
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?compat=all&channel=stable&platform=all");
    // 「全部」不预设列表里一定有不兼容项，只说「含不匹配的」。
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain("正在显示全部扩展");
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain("含与本版本不匹配的");
    // 新口径的第一页重新拿到游标：追加从这一页继续，而不是沿用旧结果集的游标。
    click(target, '[data-role="more"]');
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe(
      "/api/store/catalog?compat=all&channel=stable&platform=all&cursor=cursor-2",
    );

    box.checked = true;
    box.dispatchEvent({ type: "change" });
    await flush();
    // 显式 compatible 也必须发出去：服务端默认值随宿主变化，省略会被解释成另一个口径。
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?compat=compatible&channel=stable&platform=all");
  });

  test("a dev host defaults to showing everything, so the switch starts unchecked", async () => {
    const bridge = fakeBridge({ catalog: devCatalog() });
    const { target } = render(bridge);
    await flush();

    // 开发版宿主默认不过滤：开关与页级说明都跟「实际生效口径」走，而不是跟默认选择走。
    const field = target.querySelector('[data-role="compat-toggle"]') as any;
    expect(field.hidden).toBe(false);
    expect((target.querySelector(".sfstore__toggle-input") as any).checked).toBe(false);
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toBe(
      "开发版宿主：默认显示全部（不按版本过滤）；兼容性以安装时 core 的判定为准。",
    );
  });

  test("checking the switch on a dev host filters by the git-tag version and says so", async () => {
    const bridge = fakeBridge({ catalog: devCatalog() });
    const { target } = render(bridge);
    await flush();

    const box = target.querySelector(".sfstore__toggle-input") as any;
    box.checked = true;
    box.dispatchEvent({ type: "change" });
    await flush();

    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?compat=compatible&channel=stable&platform=all");
    // 开关在请求飞行期间也不会跳回旧值：显式口径先记账，响应回显再纠正。
    expect(box.checked).toBe(true);
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toBe(
      "开发版宿主：已按版本约束筛选；开发版的版本号来自最近的 git tag，仅供参考；能否安装以 core 判定为准。",
    );
  });

  test("the switch follows the compat the store echoed back", async () => {
    // 发行版宿主 + 服务端回显 all：开关必须是未勾的，说明也要是「全部」那一句。
    const bridge = fakeBridge({
      catalog: { ...compatibleCatalog(), compat: "all" as const },
    });
    const { target } = render(bridge);
    await flush();

    expect((target.querySelector(".sfstore__toggle-input") as any).checked).toBe(false);
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain("正在显示全部扩展");
  });

  test("the mode survives other filters and travels with them", async () => {
    const bridge = fakeBridge({ catalog: compatibleCatalog() });
    const { target } = render(bridge);
    await flush();
    const box = target.querySelector(".sfstore__toggle-input") as any;
    box.checked = false;
    box.dispatchEvent({ type: "change" });
    await flush();

    const select = target.querySelector('[data-role="channel"]') as any;
    select.value = "all";
    select.dispatchEvent({ type: "change" });
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?compat=all&platform=all");
  });
});

describe("card cover and mark", () => {
  // 三级回退：分享卡 → 图标 → 字母块。任何一级破图都退到下一级，绝不留破图。
  test("the share card is the card cover, cropped 2:1 and lazily decoded", async () => {
    const bridge = fakeBridge({ catalog: coveredCatalog() });
    const { target } = render(bridge);
    await flush();
    const card = target.querySelector('[data-slug="markdown"]') as any;

    const cover = card.querySelector(".sfstore__cover-img") as any;
    expect(cover).not.toBeNull();
    expect(cover.src).toBe(COVER);
    expect(cover.loading).toBe("lazy");
    expect(cover.decoding).toBe("async");
    // 分享卡是 1280×640：卡片盒子按 2:1 裁切，图按 320×160 声明。
    expect(cover.width).toBe(320);
    expect(cover.height).toBe(160);
    const box = cover.parentNode as any;
    expect(box.className).toContain("sfstore__card-cover");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    // 一级封面就是那一层：图标不在同一张卡上重复占位。
    expect(card.querySelectorAll(".sfstore__mark-img").length).toBe(0);
  });

  test("a broken cover falls to the icon, then to the letter mark", async () => {
    const bridge = fakeBridge({ catalog: coveredCatalog() });
    const { target } = render(bridge);
    await flush();
    const card = target.querySelector('[data-slug="markdown"]') as any;

    card.querySelector(".sfstore__cover-img").dispatchEvent({ type: "error" });
    const icon = card.querySelector(".sfstore__mark-img") as any;
    expect(icon).not.toBeNull();
    expect(icon.src).toBe(COVER_ICON);
    expect(icon.parentNode?.className).toContain("sfstore__card-mark");

    icon.dispatchEvent({ type: "error" });
    expect(card.querySelector(".sfstore__cover-img")).toBeNull();
    expect(card.querySelector(".sfstore__mark-img")).toBeNull();
    expect(card.querySelector(".sfstore__card-mark")!.textContent).toBe("M");
  });

  test("a cover without an icon still degrades to the letter mark", async () => {
    const bridge = fakeBridge({
      catalog: {
        ...CATALOG,
        items: CATALOG.items.map((item, index) =>
          index === 0 ? { ...item, socialImageUrl: COVER } : item,
        ),
      },
    });
    const { target } = render(bridge);
    await flush();
    const card = target.querySelector('[data-slug="markdown"]') as any;
    card.querySelector(".sfstore__cover-img").dispatchEvent({ type: "error" });
    expect(card.querySelector(".sfstore__mark-img")).toBeNull();
    expect(card.querySelector(".sfstore__card-mark")!.textContent).toBe("M");
  });

  test("the legacy backend without cover fields renders no <img> at all", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    const card = target.querySelector('[data-slug="markdown"]') as any;
    expect(card.querySelector(".sfstore__cover-img")).toBeNull();
    expect(card.querySelector(".sfstore__mark-img")).toBeNull();
    expect(card.querySelector(".sfstore__card-mark")!.textContent).toBe("M");
  });

  test("an icon-only catalog renders the icon mark, not a duplicate tile", async () => {
    const icon = "https://store.example.com/api/assets/8f".concat("a".repeat(62));
    const bridge = fakeBridge({
      catalog: {
        ...CATALOG,
        items: CATALOG.items.map((item, index) => (index === 0 ? { ...item, iconUrl: icon } : item)),
      },
    });
    const { target } = render(bridge);
    await flush();
    const card = target.querySelector('[data-slug="markdown"]') as any;

    const image = card.querySelector(".sfstore__mark-img") as any;
    expect(image).not.toBeNull();
    expect(image.src).toBe(icon);
    expect(image.alt).toBe("");
    expect(card.querySelector(".sfstore__card-cover")!.getAttribute("aria-hidden")).toBe("true");
    // 图占位时，mark 里没有字母。
    expect(image.parentNode?.textContent).toBe("");
  });

  test("the dialog header uses the same 2:1 cover at 192×96 and falls back the same way", async () => {
    const bridge = fakeBridge({
      product: { product: { ...PRODUCT.product, socialImageUrl: COVER, iconUrl: COVER_ICON } },
    });
    const context = await openFirstCard(bridge);

    const box = context.document.body.querySelector(".sfstore__dialog-mark") as any;
    const cover = box.querySelector(".sfstore__cover-img") as any;
    expect(cover.src).toBe(COVER);
    expect(cover.width).toBe(192);
    expect(cover.height).toBe(96);

    cover.dispatchEvent({ type: "error" });
    const icon = box.querySelector(".sfstore__mark-img") as any;
    expect(icon.src).toBe(COVER_ICON);
    icon.dispatchEvent({ type: "error" });
    expect(box.querySelector(".sfstore__cover-img")).toBeNull();
    expect(box.querySelector(".sfstore__mark-img")).toBeNull();
    expect(box.textContent).toBe("M");
  });
});

describe("installed and update badges", () => {
  test("the card flag and the detail head report the installed version and the available update", async () => {
    const bridge = fakeBridge({ catalog: installedCatalog(), product: installedProduct() });
    const context = await openFirstCard(bridge);

    const card = context.target.querySelector('[data-slug="markdown"]') as any;
    // 可更新只出现一次：封面右上角标承载它，meta 里不重复。
    expect(card.querySelector(".sfstore__card-flag--update")!.textContent).toBe("可更新至 v1.4.2");
    const meta = card.querySelector(".sfstore__card-meta") as any;
    expect(meta.textContent).toContain("已安装 v1.2.0");
    expect(meta.textContent).not.toContain("可更新至");
    // 卡片不展开宿主状态：那是详情里的次要说明。
    expect(card.textContent).not.toContain("已在宿主停用");

    const head = context.document.body.querySelector(".sfstore__dialog-head") as any;
    // 卡片靠角标去重，弹窗没有角标：头部是唯一同时给出「已装什么 / 能升到什么」的地方。
    expect(head.textContent).toContain("已安装 v1.2.0");
    expect(head.textContent).toContain("可更新至 v1.4.2");
    expect(head.querySelectorAll(".sfstore__badge").length).toBe(3);
    expect(head.querySelectorAll(".sfstore__badge--accent").length).toBe(1);
    expect(dialogHTML(context)).toContain("已在宿主停用");
    // 强调色的可更新徽标不得取代安装按钮。
    expect(context.document.body.querySelector('[data-action="install"]')!.textContent).toBe(
      "安装到论坛",
    );
    expect(
      context.document.body.querySelectorAll(".sfstore__badge--accent").length,
    ).toBeGreaterThan(0);
  });

  test("not installed: no badge at all, even when the store flags an update", async () => {
    const bridge = fakeBridge({
      catalog: {
        ...CATALOG,
        items: CATALOG.items.map((item, index) =>
          index === 0 ? { ...item, updateAvailable: true } : item,
        ),
      },
      product: { product: { ...PRODUCT.product, updateAvailable: true } },
    });
    const context = await openFirstCard(bridge);
    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).not.toContain("已安装 v");
    expect(html).not.toContain("可更新至");
    expect(context.target.querySelector(".sfstore__card-flag")).toBeNull();
  });

  test("installed at the newest version: version badge only, plus the host status note", async () => {
    const bridge = fakeBridge({
      catalog: {
        ...CATALOG,
        items: CATALOG.items.map((item, index) =>
          index === 0
            ? { ...item, installed: { version: "1.4.2", status: "installed" }, updateAvailable: false }
            : item,
        ),
      },
      product: {
        product: {
          ...PRODUCT.product,
          installed: { version: "1.4.2", status: "installed" },
          updateAvailable: false,
        },
      },
    });
    const context = await openFirstCard(bridge);
    // 已装且最新：角标写已安装版本，没有可更新角标。
    expect(
      context.target.querySelector(".sfstore__card-flag--installed")!.textContent,
    ).toBe("已安装 v1.4.2");
    expect(context.target.querySelector(".sfstore__card-flag--update")).toBeNull();
    const html = dialogHTML(context);
    expect(html).toContain("已安装 v1.4.2");
    expect(html).not.toContain("可更新至");
    // 宿主状态 `installed`（装了还没启用）只在详情补一句。
    expect(html).toContain("已装，尚未启用");
  });

  test("en-US renders the badges in English and leaves no Chinese", async () => {
    const bridge = fakeBridge({
      locale: "en-US",
      catalog: asciiInstalledCatalog(),
      product: asciiInstalledProduct(),
    });
    const context = await openFirstCard(bridge);
    expect(context.target.querySelector(".sfstore__card-flag--update")!.textContent).toBe(
      "Update to v1.4.2",
    );
    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).toContain("Installed v1.2.0");
    expect(html).toContain("Update to v1.4.2");
    expect(html).toContain("Disabled in this host");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe("default platform", () => {
  const release = {
    version: "1.0.0",
    channel: "stable" as const,
    channelLabel: "稳定版",
    publishedAt: "2026-10-01T00:00:00.000Z",
    publishedLabel: "2026-10-01",
    sforumVersion: ">=1.0.0",
    status: "published",
    statusLabel: "已发布",
    installable: true,
    digestPrefix: "",
    capabilities: [],
    notes: "",
    platforms: [
      { os: "darwin", arch: "arm64", label: "darwin/arm64" },
      { os: "linux", arch: "amd64", label: "linux/amd64" },
    ],
  };

  test("prefers the platform the plugin backend runs on", () => {
    // 安装目标是服务器，不是管理员浏览器；默认选错平台会装错包。
    expect(defaultPlatform(release, { os: "linux", arch: "amd64" })?.label).toBe("linux/amd64");
  });

  test("falls back to any/any, then the first asset", () => {
    const themed = {
      ...release,
      platforms: [
        { os: "darwin", arch: "arm64", label: "darwin/arm64" },
        { os: "any", arch: "any", label: "任意平台" },
      ],
    };
    expect(defaultPlatform(themed, { os: "windows", arch: "amd64" })?.label).toBe("任意平台");
    expect(defaultPlatform(release, null)?.label).toBe("darwin/arm64");
    expect(defaultPlatform(null, { os: "linux", arch: "amd64" })).toBeNull();
  });

  test("catalog responses carry the target platform", () => {
    const parsed = parseCatalog({
      items: [],
      total: 0,
      compatibility: { status: "unknown", estimated: false },
      target: { os: "linux", arch: "amd64" },
    });
    expect(parsed.target).toEqual({ os: "linux", arch: "amd64" });
  });
});

describe("locale", () => {
  test("resolveLocale reads only the `en` prefix and never throws", () => {
    for (const value of ["en-US", "en", "EN-gb", " en_us ", "enGB"]) {
      expect(resolveLocale(value)).toBe("en-US");
    }
    for (const value of ["zh-CN", "zh", "zh-TW", "fr-FR", "", "  ", undefined, null, 42, {}, []]) {
      expect(resolveLocale(value)).toBe("zh-CN");
    }
  });

  test("both locales expose the same keys with non-empty copy", () => {
    const zh = Object.keys(COPY_TABLES["zh-CN"]).sort();
    const en = Object.keys(COPY_TABLES["en-US"]).sort();
    expect(en).toEqual(zh);
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const key of zh) {
        expect(COPY_TABLES[locale][key as CopyKey].trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("placeholders interpolate and survive a missing param", () => {
    expect(createCopy("en-US").t("resultCount", { count: 3 })).toBe("3 results");
    expect(createCopy("zh-CN").t("resultCount", { count: 3 })).toBe("共 3 个结果");
    expect(createCopy("en-US").t("resultCount")).toBe("{count} results");
  });

  test("en-US renders the catalog shell in English", async () => {
    const bridge = fakeBridge({ locale: "en-US" });
    const { target } = render(bridge);
    await flush();

    expect(target.querySelector('[data-role="root"]')!.getAttribute("lang")).toBe("en-US");
    expect((target.querySelector('[data-role="search"]') as any).placeholder).toBe(
      "Name, extension ID, or summary",
    );
    expect(target.querySelector('[data-role="count"]')!.textContent).toBe("2 results");
    expect(target.querySelector('[data-role="stale"]')!.textContent).toContain("Cached data from");
    expect(target.querySelector('[data-role="more"]')!.textContent).toBe("Load more");
    expect(target.querySelector('[data-role="refresh"]')!.textContent).toBe("Refresh");
    // 页面标题与简介由宿主壳渲染：本页只剩目录的 aria-label 与卡片按钮名。
    expect(target.querySelector('[data-role="list"]')!.getAttribute("aria-label")).toBe(
      "Store catalog",
    );
    expect(target.querySelectorAll(".sfstore__card")[0]!.getAttribute("aria-label")).toBe(
      "View details for Markdown 增强",
    );

    const html = toHTML(target);
    expect(html).toContain("Plugin");
    expect(html).not.toContain("Not checked");
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "does not report a usable version",
    );
    expect(html).toContain("Any platform");
    // 开发版属性不再进徽标：卡片最后一枚是清单约束，宿主说明只在页级那一句。
    const last = target.querySelectorAll(".sfstore__card-meta")[0]!.children.at(-1) as any;
    expect(last.textContent).toBe("sforum >=1.0.0 <2.0.0");
    expect(html).not.toContain("Estimated from a dev build");
    expect(html).not.toContain("未校验");
    expect(html).not.toContain("共 2 个结果");
  });

  test("en-US localizes the channel and category filters", () => {
    const copy = createCopy("en-US");
    expect(channelOptions(copy)).toEqual([
      { value: "stable", label: "Stable" },
      { value: "all", label: "Include pre-releases" },
    ]);
    expect(categoryOptions(copy).map((option) => option.label)).toEqual([
      "All categories",
      "Content",
      "Appearance",
      "Community",
      "Integrations",
      "Operations",
      "Security",
    ]);
    // Requests are unchanged by locale: the filter values are the contract.
    expect(channelOptions(copy).map((option) => option.value)).toEqual(
      channelOptions().map((option) => option.value),
    );
    expect(categoryOptions(copy).map((option) => option.value)).toEqual(
      categoryOptions().map((option) => option.value),
    );
  });

  test("en-US localizes the detail view, version table and install flow", async () => {
    const bridge = fakeBridge({ locale: "en-US" });
    const context = await openFirstCard(bridge);

    const html = dialogHTML(context);
    // 平台既不在弹窗头部，也不再有下拉：它由宿主 target 自动决定。
    expect(context.document.body.querySelector('[data-action="platform"]')).toBeNull();
    expect(html).toContain("Versions");
    expect(html).toContain("Version list");
    expect(html).toContain("sforum constraint");
    expect(html).toContain("Capabilities");
    expect(html).toContain("Digest");
    expect(html).toContain("Yanked");
    expect(html).toContain("README");
    expect(html).toContain("View on GitHub");
    expect(context.document.body.querySelector('[data-label="Version"]')).not.toBeNull();
    expect(context.document.body.querySelector('[data-label="Digest"]')).not.toBeNull();
    expect(context.document.body.querySelector('[data-action="install"]')!.textContent).toBe(
      "Install to forum",
    );

    dialogClick(context, '[data-action="install"]');
    await flush();

    const stagedHtml = dialogHTML(context);
    expect(stagedHtml).toContain("Staged");
    expect(stagedHtml).toContain("Enabling and trusting happen in core");
    expect(bridge.toasts[0]).toEqual({
      title: "Staged",
      description: "Enabling and trusting happen in core",
      kind: "success",
    });
    // Success means staged only. The check is scoped to the staging result: an "Installed v…"
    // badge elsewhere in the header reports the host inventory, not this page's install.
    const stagedText = context.document.body
      .querySelector(".sfstore__receipt")!
      .textContent.toLowerCase();
    for (const banned of ["installed", "updated", "verified build", "auto-upgrade", "auto upgrade"]) {
      expect(stagedText.includes(banned)).toBe(false);
    }
  });

  test("en-US explains the legacy-host limit and hands out a signed link", async () => {
    const bridge = fakeBridge({ locale: "en-US", install: false });
    const context = await openFirstCard(bridge);
    const html = dialogHTML(context);
    expect(html).toContain("This host does not support in-page installs");
    expect(context.document.body.querySelector('[data-action="sign"]')!.textContent).toBe(
      "Get a signed link",
    );

    dialogClick(context, '[data-action="sign"]');
    await flush();
    const signedHtml = dialogHTML(context);
    expect(signedHtml).toContain("The link is valid for 30 minutes");
    expect(signedHtml).toContain("paste the link and the SHA-256");
    expect(signedHtml).toContain("Copy link");
    expect(signedHtml).toContain("Open the core install page");
    expect(bridge.toasts.at(-1)).toEqual({
      title: "Signed link ready",
      description: "The link is valid for 30 minutes",
      kind: "success",
    });
  });

  test("en-US maps a rejected install to English copy", async () => {
    const bridge = fakeBridge({
      locale: "en-US",
      installImpl: async () => {
        const error = new Error("install_cancelled") as Error & { code: string };
        error.code = "install_cancelled";
        throw error;
      },
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();
    // 用户主动取消不是故障：只在 footer 状态位写一句，不弹不会自动消失的错误 Toast。
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "Cancelled (leaving the page aborts the install)",
    );
    expect(dialogHTML(context)).toContain("Cancelled (leaving the page aborts the install)");
    expect(bridge.toasts).toHaveLength(0);
  });

  test("en-US uses the singular result count", async () => {
    const bridge = fakeBridge({ locale: "en-US", catalog: { ...CATALOG, items: [CATALOG.items[0]], total: 1 } });
    const { target } = render(bridge);
    await flush();
    expect(target.querySelector('[data-role="count"]')!.textContent).toBe("1 result");
  });

  test("zh-CN, a missing locale and an unknown locale all render Chinese", async () => {
    for (const locale of ["zh-CN", undefined, "fr-FR", "zh-TW"]) {
      const bridge = fakeBridge(locale === undefined ? {} : { locale });
      const { target } = render(bridge);
      await flush();
      expect(target.querySelector('[data-role="count"]')!.textContent).toBe("共 2 个结果");
      expect(toHTML(target)).not.toContain("未校验");
      expect(target.querySelector('[data-role="refresh"]')!.textContent).toBe("刷新");
      expect(target.querySelector('[data-role="more"]')!.textContent).toBe("加载更多");
    }
  });

  test("a bridge without locale or t never throws and stays on zh-CN", async () => {
    const bridge = fakeBridge();
    delete (bridge as Record<string, unknown>).locale;
    const { target } = render(bridge);
    await flush();
    expect(toHTML(target)).toContain("刷新");
    expect(toHTML(target)).toContain("共 2 个结果");
  });
});

describe("copy completeness", () => {
  const CJK = /[\u4e00-\u9fff]/;

  test("an ASCII catalog leaves no Chinese in the en-US render", async () => {
    const bridge = fakeBridge({ locale: "en-US", catalog: ASCII_CATALOG, product: ASCII_PRODUCT });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="install"]');
    await flush();

    // 目录在页面根、详情在 body：两处都要干净。
    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).toContain("Staged");
    expect(html).toContain("Release notes");
    expect(html).toContain("ASCII release notes.");
    expect(html).toContain("README");
    expect(html).toContain("View on GitHub");
    expect(html).toContain("<h1>Markdown Plus</h1>");
    expect(html).not.toMatch(CJK);
  });

  test("an ASCII catalog leaves no Chinese in the en-US signed-link path", async () => {
    const bridge = fakeBridge({
      locale: "en-US",
      catalog: ASCII_CATALOG,
      product: ASCII_PRODUCT,
      install: false,
    });
    const context = await openFirstCard(bridge);
    dialogClick(context, '[data-action="sign"]');
    await flush();

    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).toContain("Signed download link");
    expect(html).not.toMatch(CJK);
  });

  test("an author strip and a gated install bar stay ASCII in en-US", async () => {
    const bridge = fakeBridge({
      locale: "en-US",
      catalog: ASCII_CATALOG,
      product: {
        product: {
          ...ASCII_PRODUCT.product,
          author: {
            username: "ada",
            displayName: "Ada Lovelace",
            avatarUrl: null,
            github: { login: "acme", url: "https://github.com/acme" },
          },
          installed: { version: "1.4.2", status: "enabled" },
          releases: ASCII_PRODUCT.product.releases.map((release) => ({
            ...release,
            installedRelation: release.version === "1.4.2" ? "same" : "older",
            notesHtml: release.version === "1.4.2" ? "<h4>Changes</h4>" : null,
          })),
        },
      },
    });
    const context = await openFirstCard(bridge);

    const strip = context.document.body.querySelector(".sfstore__author") as any;
    expect(strip.querySelector(".sfstore__author-label")!.textContent).toBe(
      "GitHub repository account",
    );
    expect(context.document.body.querySelector('[data-action="uninstall"]')).toBeNull();
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "v1.4.2 is already installed; the same version needs no second install",
    );

    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).not.toMatch(CJK);
  });

  test("the same ASCII catalog still renders Chinese chrome for zh-CN", async () => {
    const bridge = fakeBridge({ catalog: ASCII_CATALOG, product: ASCII_PRODUCT });
    const context = await openFirstCard(bridge);
    const html = toHTML(context.target) + dialogHTML(context);
    expect(html).toMatch(CJK);
    expect(html).toContain("版本信息");
    expect(html).toContain("更新说明");
    expect(html).toContain("在 GitHub 查看");
    expect(context.document.body.querySelector('[data-action="install"]')!.textContent).toBe(
      "安装到论坛",
    );
  });
});

// ---------- 安装门禁：页面对「已装什么」做展示，不做版本比较 ----------

/**
 * 详情夹具：把已装版本与每个版本的 relation 一起换掉。relation 由插件后端算
 * （`mapping.go installedRelation`），页面只消费，所以夹具必须显式给出它。
 */
const gatedProduct = (
  installedVersion: string | null,
  relations: Record<string, "newer" | "same" | "older" | "unknown">,
) => ({
  product: {
    ...PRODUCT.product,
    installed: installedVersion === null ? null : { version: installedVersion, status: "enabled" },
    updateAvailable: false,
    releases: PRODUCT.product.releases.map((release) =>
      relations[release.version] ? { ...release, installedRelation: relations[release.version] } : release,
    ),
  },
});

describe("install gate in the footer", () => {
  test("not installed: the primary action installs", async () => {
    const bridge = fakeBridge();
    const context = await openFirstCard(bridge);
    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("安装到论坛");
    expect(action.disabled).toBe(false);
    // 没有已装版本就没有可卸载的对象。
    expect(context.document.body.querySelector('[data-action="uninstall"]')).toBeNull();
  });

  test("a newer version turns the action into an upgrade and labels the option", async () => {
    const bridge = fakeBridge({
      product: gatedProduct("1.2.0", { "1.4.2": "newer", "1.5.0-beta.1": "newer" }),
    });
    const context = await openFirstCard(bridge);

    const action = context.document.body.querySelector('[data-action="install"]') as any;
    expect(action.textContent).toBe("更新到 v1.4.2");
    expect(action.disabled).toBe(false);

    // 下拉本身也要说清这一版相对已装版本在哪：选中之前就能看到结论。
    const select = context.document.body.querySelector('select[data-action="version"]') as any;
    const labels = select.querySelectorAll("option").map((option: any) => option.textContent);
    expect(labels[0]).toBe("1.4.2 · 稳定版 · 可升级");
  });

  test("the same version blocks the button and says why, without an uninstall shortcut", async () => {
    const bridge = fakeBridge({ product: gatedProduct("1.4.2", { "1.4.2": "same" }) });
    const context = await openFirstCard(bridge);

    expect(context.document.body.querySelector('[data-action="install"]')).toBeNull();
    const blocked = context.document.body.querySelector('[data-action="install-blocked"]') as any;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toBe("已安装 v1.4.2");

    const state = context.document.body.querySelector('[data-role="foot-state"]') as any;
    expect(state.textContent).toBe("已安装 v1.4.2，同版本无需再装");

    // 卸载是 core 的动作：商城页不给快捷入口，只说明原因。
    expect(context.document.body.querySelector('[data-action="uninstall"]')).toBeNull();
    expect(bridge.navigations).toEqual([]);
  });

  test("an older version is blocked and names both sides", async () => {
    const bridge = fakeBridge({
      product: gatedProduct("2.0.0", { "1.4.2": "older", "1.5.0-beta.1": "older" }),
    });
    const context = await openFirstCard(bridge);

    const blocked = context.document.body.querySelector('[data-action="install-blocked"]') as any;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toBe("已安装 v2.0.0");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "选中 v1.4.2 低于已安装的 v2.0.0",
    );
  });

  test("an uncomparable pair stays blocked without inventing a verdict", async () => {
    const bridge = fakeBridge({ product: gatedProduct("dev-abc12", { "1.4.2": "unknown" }) });
    const context = await openFirstCard(bridge);

    expect(context.document.body.querySelector('[data-action="install"]')).toBeNull();
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toContain(
      "无法比较版本",
    );
  });

  test("the legacy host keeps its signed-link action and gets no uninstall entry", async () => {
    const bridge = fakeBridge({
      install: false,
      product: gatedProduct("1.4.2", { "1.4.2": "same" }),
    });
    const context = await openFirstCard(bridge);

    expect(context.document.body.querySelector('[data-action="install-blocked"]')).toBeNull();
    expect(context.document.body.querySelector('[data-action="uninstall"]')).toBeNull();
    expect(context.document.body.querySelector('[data-action="sign"]')).not.toBeNull();
  });
});

// ---------- 作者信息：两个来源，缺一半就不画那一半 ----------

const authorProduct = (author: unknown) => ({
  product: { ...PRODUCT.product, author },
});

describe("author strip", () => {
  test("a full author renders above the README with a GitHub link", async () => {
    const bridge = fakeBridge({
      product: authorProduct({
        username: "ada",
        displayName: "Ada Lovelace",
        avatarUrl: "https://forum.example/ada.png",
        github: { login: "acme", url: "https://github.com/acme" },
      }),
    });
    const context = await openFirstCard(bridge);
    const panel = context.document.body.querySelector("#sfstore-panel-readme") as any;

    // 位置就是契约：第一个子节点是作者条，其次是 README。
    expect(panel.children[0].className).toBe("sfstore__author");
    const strip = panel.querySelector(".sfstore__author") as any;
    expect(strip.getAttribute("aria-label")).toBe("维护者");
    expect(strip.querySelector(".sfstore__author-name")!.textContent).toBe("Ada Lovelace @ada");
    // 第一行是论坛身份，副行只讲 GitHub 那一半，并且带自己的标签。
    expect(strip.querySelector(".sfstore__author-label")!.textContent).toBe("GitHub 仓库账号");
    const github = strip.querySelector("a") as any;
    expect(github.textContent).toBe("@acme");
    expect(github.href).toBe("https://github.com/acme");
    expect(github.rel).toBe("noreferrer noopener");
  });

  test("the handle links to the forum profile the store resolved", async () => {
    const bridge = fakeBridge({
      product: authorProduct({
        username: "ada",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        profileUrl: "https://forum.example/u/ada",
        github: null,
      }),
    });
    const context = await openFirstCard(bridge);
    const handle = context.document.body.querySelector(".sfstore__author-profile") as any;

    expect(handle).not.toBeNull();
    expect(handle.textContent.trim()).toBe("@ada");
    expect(handle.href).toBe("https://forum.example/u/ada");
    expect(handle.target).toBe("_blank");
    expect(handle.rel).toBe("noreferrer noopener");
    expect(handle.title).toBe("论坛个人主页");
  });

  test("without a profile URL the handle stays plain text instead of a dead link", async () => {
    const bridge = fakeBridge({
      product: authorProduct({
        username: "ada",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        profileUrl: null,
        github: null,
      }),
    });
    const context = await openFirstCard(bridge);
    expect(context.document.body.querySelector(".sfstore__author-profile")).toBeNull();
    expect(
      context.document.body.querySelector(".sfstore__author-handle")!.textContent,
    ).toContain("@ada");
  });

  test("a repository-only author prints the login instead of an empty name", async () => {
    const bridge = fakeBridge({
      product: authorProduct({
        username: null,
        displayName: null,
        avatarUrl: null,
        github: { login: "acme", url: "https://github.com/acme" },
      }),
    });
    const context = await openFirstCard(bridge);
    const strip = context.document.body.querySelector(".sfstore__author") as any;
    expect(strip.querySelector(".sfstore__author-name")!.textContent).toBe("@acme");
    // 只有仓库时，副行仍然标明这是 GitHub 账号，而不是让 @acme 冒充论坛用户名。
    expect(strip.querySelector(".sfstore__author-label")!.textContent).toBe("GitHub 仓库账号");
    expect(strip.querySelector("a")!.textContent).toBe("@acme");
  });

  test("no author block at all when both halves are missing", async () => {
    const bridge = fakeBridge({ product: authorProduct(null) });
    const context = await openFirstCard(bridge);
    expect(context.document.body.querySelector(".sfstore__author")).toBeNull();
  });

  test("a broken avatar falls back to the letter tile instead of a broken image", async () => {
    const bridge = fakeBridge({
      product: authorProduct({ username: "ada", avatarUrl: "https://forum.example/gone.png" }),
    });
    const context = await openFirstCard(bridge);
    const avatar = context.document.body.querySelector(".sfstore__author-avatar") as any;
    expect(avatar.querySelector(".sfstore__author-img").src).toBe("https://forum.example/gone.png");

    avatar.querySelector(".sfstore__author-img").dispatchEvent({ type: "error" });
    expect(avatar.querySelector(".sfstore__author-img")).toBeNull();
    expect(avatar.querySelector(".sfstore__author-initial").textContent).toBe("A");
  });
});

// ---------- 更新说明：优先注入服务端渲染的 HTML，老商城退回纯文本 ----------

describe("release notes rendering", () => {
  const notesWithHtml = (notes: string, notesHtml: string) => ({
    product: {
      ...PRODUCT.product,
      releases: PRODUCT.product.releases.map((release) =>
        release.version === "1.4.2" ? { ...release, notes, notesHtml } : release,
      ),
    },
  });

  test("rendered HTML is injected into the same readme container", async () => {
    const bridge = fakeBridge({
      product: notesWithHtml(
        "## 变更",
        "<h4>变更</h4>\n<ul>\n<li>支持表格</li>\n</ul>",
      ),
    });
    const context = await openFirstCard(bridge);
    const panel = context.document.body.querySelector("#sfstore-panel-notes") as any;
    const body = panel.querySelector(".sforum-store-readme") as any;

    expect(body).not.toBeNull();
    expect(body.parentNode.className).toBe("sfstore__note-item");
    // 注入的是服务端产物：容器里就是那段 HTML（替身不解析 innerHTML 的子节点）。
    expect(body.innerHTML).toContain("<h4>变更</h4>");
    expect(body.innerHTML).toContain("<li>支持表格</li>");
    // 注入的是渲染结果，原始 Markdown 不再出现。
    expect(panel.textContent).not.toContain("## 变更");
    // 版本头是 h3：正文标题在它下面，大纲不倒退。
    expect(panel.querySelector(".sfstore__note-head")!.tagName.toLowerCase()).toBe("h3");
  });

  test("an older store that sends only the Markdown source falls back to plain text", async () => {
    const bridge = fakeBridge({
      product: {
        product: {
          ...PRODUCT.product,
          releases: PRODUCT.product.releases.map((release) =>
            release.version === "1.4.2" ? { ...release, notes: "## 变更" } : release,
          ),
        },
      },
    });
    const context = await openFirstCard(bridge);
    const panel = context.document.body.querySelector("#sfstore-panel-notes") as any;

    expect(panel.querySelector(".sforum-store-readme")).toBeNull();
    expect(panel.querySelector(".sfstore__prose")!.textContent).toBe("## 变更");
  });
});

// ---------- 架构可用性：商城让你看见并选择，core 仍是最终裁判 ----------

const LINUX = { os: "linux", arch: "amd64" };
const MAC = { os: "darwin", arch: "arm64" };
const ANY_PLATFORM = { os: "any", arch: "any" };

/** 目录夹具：宿主是 linux/amd64，第一张卡的「最新版平台」由参数决定。 */
const platformCatalog = (latestPlatforms: unknown, allPlatforms: unknown) => ({
  ...CATALOG,
  target: LINUX,
  items: [
    { ...CATALOG.items[0], latestPlatforms, platforms: allPlatforms },
    CATALOG.items[1],
  ],
});

/** 详情夹具：按版本给资产平台；没列出的版本没有资产（因而不可安装）。 */
const platformProduct = (assetsByVersion: Record<string, Array<{ os: string; arch: string }>>) => ({
  product: {
    ...PRODUCT.product,
    platforms: [LINUX, MAC],
    releases: PRODUCT.product.releases.map((release) => ({
      ...release,
      assets: (assetsByVersion[release.version] ?? []).map((platform) => ({
        os: platform.os,
        arch: platform.arch,
        filename: "demo.zip",
        size: 1024,
        sha256: "ab",
      })),
    })),
  },
});

function cardMetaTexts(root: any, slug: string): string[] {
  const card = root.querySelector(`[data-slug="${slug}"]`);
  if (!card) throw new Error(`card ${slug} was not rendered`);
  return card.querySelector(".sfstore__card-meta").children.map((node: any) => node.textContent);
}

describe("platform availability", () => {
  test("the catalog always asks for every platform and the page has no architecture switch", async () => {
    const bridge = fakeBridge({ catalog: platformCatalog([MAC], [LINUX, MAC]) });
    const { target } = render(bridge);
    await flush();

    // 架构不再由人挑：目录恒要全部平台，产品不因为异架构从列表里消失。
    expect(bridge.requests[0]!.path).toBe("/api/store/catalog?channel=stable&platform=all");
    expect(target.querySelector('[data-role="platform-toggle"]')).toBeNull();
  });

  test("an old store that reports no target draws no architecture verdict", async () => {
    // 没有 target 就没有「当前架构」这句话可讲：未知不是「不支持」。
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();

    expect(cardMetaTexts(target, "markdown").join(" ")).not.toContain("架构");
  });

  test("the card marks a latest version built for another architecture", async () => {
    const bridge = fakeBridge({ catalog: platformCatalog([MAC], [LINUX, MAC]) });
    const { target } = render(bridge);
    await flush();

    const texts = cardMetaTexts(target, "markdown");
    expect(texts).toContain("最新版不支持当前架构");
    // 旧版本仍支持当前架构：说的是「最新版不行」，不是「整包不行」。
    expect(texts).not.toContain("不支持当前架构");
  });

  test("a product no release of which supports this architecture is marked once", async () => {
    const bridge = fakeBridge({ catalog: platformCatalog([MAC], [MAC]) });
    const { target } = render(bridge);
    await flush();

    const texts = cardMetaTexts(target, "markdown");
    expect(texts).toContain("不支持当前架构");
    expect(texts).not.toContain("最新版不支持当前架构");
  });

  test("an unsupported product does not repeat the verdict as 不兼容", async () => {
    const bridge = fakeBridge({
      catalog: {
        ...platformCatalog([MAC], [MAC]),
        items: [
          {
            ...CATALOG.items[0],
            latestPlatforms: [MAC],
            platforms: [MAC],
            compatibility: { status: "incompatible" as const, estimated: false },
          },
          CATALOG.items[1],
        ],
      },
    });
    const { target } = render(bridge);
    await flush();

    // 商城在 platform=all 下仍按 os/arch 算 compatibility，所以异架构产品会同时是
    // incompatible；架构判决已经说了同一件事，卡片不再叠一枚「不兼容」。
    const texts = cardMetaTexts(target, "markdown");
    expect(texts).toContain("不支持当前架构");
    expect(texts).not.toContain("不兼容");
  });

  test("a supported product says 支持当前架构 and drops the raw platform chip", async () => {
    const bridge = fakeBridge({ catalog: platformCatalog([LINUX], [LINUX, MAC]) });
    const { target } = render(bridge);
    await flush();

    const texts = cardMetaTexts(target, "markdown");
    expect(texts).toContain("支持当前架构");
    // 判决顶掉原始平台 chip：同一件事不说两遍，徽标行也不会因此折行。
    expect(texts).not.toContain("linux/amd64");
    expect(texts).not.toContain("darwin/arm64");
  });

  test("an old store without latestPlatforms falls back to the platform union", async () => {
    // 新页面 + 半新商城：没有 `latestPlatforms` 时按并集判，宁可少拦一次也不误锁目录。
    const bridge = fakeBridge({ catalog: platformCatalog(undefined, [LINUX, MAC]) });
    const { target } = render(bridge);
    await flush();

    expect(cardMetaTexts(target, "markdown")).toContain("支持当前架构");
  });

  test("the dialog preselects the newest release this architecture can run", async () => {
    const bridge = fakeBridge({
      catalog: platformCatalog([MAC], [LINUX, MAC]),
      product: platformProduct({ "1.4.2": [MAC], "1.5.0-beta.1": [LINUX] }),
    });
    const context = await openFirstCard(bridge);

    const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
    expect(versionSelect.value).toBe("1.5.0-beta.1");
    // 选项本身也带结论：1.4.2 不可装，选中之前就能看到。
    const labels = versionSelect.querySelectorAll("option").map((option: any) => option.textContent);
    expect(labels).toContain("1.4.2 · 稳定版 · 不支持当前架构");

    // 为什么不是最新版：通知槽说一句，不让人去猜。
    expect(dialogHTML(context)).toContain(
      "最新版 v1.4.2 没有为 linux/amd64 构建的安装包，已为你选中 v1.5.0-beta.1。",
    );
    expect(context.document.body.querySelector('[data-action="install"]')).not.toBeNull();
  });

  test("the dialog has no platform select and installs the host platform", async () => {
    const bridge = fakeBridge({
      catalog: platformCatalog([LINUX], [LINUX, MAC]),
      product: platformProduct({ "1.4.2": [MAC, LINUX] }),
    });
    const context = await openFirstCard(bridge);

    // 架构选择已经不存在：平台由宿主 target 自动决定（精确匹配优先），结论写在状态位。
    expect(context.document.body.querySelector('[data-action="platform"]')).toBeNull();
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "支持当前架构（linux/amd64）",
    );
    expect(context.document.body.querySelector('[data-action="install"]')).not.toBeNull();
  });

  test("selecting a version built for another architecture disables the install and says why", async () => {
    const bridge = fakeBridge({
      catalog: platformCatalog([LINUX], [LINUX, MAC]),
      product: platformProduct({ "1.4.2": [LINUX], "1.5.0-beta.1": [MAC] }),
    });
    const context = await openFirstCard(bridge);

    const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
    versionSelect.value = "1.5.0-beta.1";
    versionSelect.dispatchEvent({ type: "change" });
    await flush();

    expect(context.document.body.querySelector('[data-action="install"]')).toBeNull();
    const blocked = context.document.body.querySelector('[data-action="install-blocked"]') as any;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toBe("安装到论坛");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "选中 v1.5.0-beta.1 没有为 linux/amd64 构建的安装包",
    );
    // 页面本来就没有平台下拉：不支持的结论只能由状态位说。
    expect(context.document.body.querySelector('[data-action="platform"]')).toBeNull();
  });

  test("a legacy host refuses to sign a link for a package this architecture cannot run", async () => {
    const bridge = fakeBridge({
      install: false,
      catalog: platformCatalog([MAC], [MAC]),
      product: platformProduct({ "1.4.2": [MAC] }),
    });
    const context = await openFirstCard(bridge);

    // 签名是商城自己的动作：明知这一版跑不起来，就不该把下载链接递出去。
    expect(context.document.body.querySelector('[data-action="sign"]')).toBeNull();
    const blocked = context.document.body.querySelector('[data-action="sign-blocked"]') as any;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toBe("获取签名链接");
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "选中 v1.4.2 没有为 linux/amd64 构建的安装包",
    );
    expect(bridge.requests.some((request) => request.path === "/api/store/install-url")).toBe(false);
  });

  test("a product no release of which supports this architecture explains and blocks", async () => {
    const bridge = fakeBridge({
      catalog: platformCatalog([MAC], [MAC]),
      product: platformProduct({ "1.4.2": [MAC], "1.5.0-beta.1": [MAC] }),
    });
    const context = await openFirstCard(bridge);

    expect(dialogHTML(context)).toContain(
      "这个产品的所有版本都没有为 linux/amd64 构建的安装包。",
    );
    const blocked = context.document.body.querySelector('[data-action="install-blocked"]') as any;
    expect(blocked.disabled).toBe(true);
    expect(context.document.body.querySelector('[data-role="foot-state"]')!.textContent).toBe(
      "选中 v1.4.2 没有为 linux/amd64 构建的安装包",
    );
  });

  test("en-US spells the platform verdicts without falling back to Chinese", async () => {
    const bridge = fakeBridge({
      locale: "en-US",
      catalog: platformCatalog([MAC], [LINUX, MAC]),
      product: platformProduct({ "1.4.2": [MAC], "1.5.0-beta.1": [LINUX] }),
    });
    const context = await openFirstCard(bridge);
    const CJK = /[\u4e00-\u9fff]/;

    // 夹具本身带中文名称，所以逐块断言：架构徽标、通知槽、版本选项都必须走 en-US 文案。
    const badge = context.target.querySelectorAll(".sfstore__badge--warn")[0] as any;
    expect(badge.textContent).toBe("Latest version not built for this platform");
    expect(badge.textContent).not.toMatch(CJK);

    const notice = context.document.body.querySelector('[data-role="dialog-notice"]') as any;
    expect(notice.textContent).toContain(
      "The latest v1.4.2 is not built for linux/amd64, so v1.5.0-beta.1 is selected.",
    );
    expect(notice.textContent).not.toMatch(CJK);

    const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
    const labels = versionSelect.querySelectorAll("option").map((option: any) => option.textContent);
    expect(labels).toContain("1.4.2 · Stable · not built for this platform");
    expect(labels.join(" ")).not.toMatch(CJK);

    // 自动选中的是能跑的 1.5.0-beta.1：正向结论同样走 en-US。
    const footState = context.document.body.querySelector('[data-role="foot-state"]') as any;
    expect(footState.textContent).toBe("Supported on this platform (linux/amd64)");
    expect(footState.textContent).not.toMatch(CJK);
  });
});

describe("connecting the store", () => {
  const REQUIRED = {
    mode: "account_required",
    connected: false,
    account: null,
    expiresAt: null,
  };
  const CONNECTED = {
    mode: "account_required",
    connected: true,
    account: { id: "acc-1", issuerKey: "forum", username: "ada", displayName: "Ada", avatarUrl: "" },
    expiresAt: "2026-11-26T00:00:00Z",
  };

  test("a store that requires sign-in shows the connect bar", async () => {
    const bridge = fakeBridge({ authStatus: REQUIRED });
    const { target } = render(bridge);
    await flush();
    const bar = target.querySelector('[data-role="auth"]') as any;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain("商城要求登录");
    expect(bar.querySelector('[data-action="auth-connect"]')).toBeTruthy();
  });

  test("an anonymous store hides the bar entirely", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    expect((target.querySelector('[data-role="auth"]') as any).hidden).toBe(true);
  });

  test("an old store is unsupported and never shows the bar", async () => {
    const bridge = fakeBridge({
      authStatus: { mode: "unsupported", connected: false, account: null, expiresAt: null },
    });
    const { target } = render(bridge);
    await flush();
    expect((target.querySelector('[data-role="auth"]') as any).hidden).toBe(true);
    expect(target.querySelector('[data-action="auth-connect"]')).toBeNull();
  });

  test("the modal button says「登录后安装」and starts the connect flow when clicked", async () => {
    // 真浏览器里 `window.open` 存在；测试替身没有，页面会走「弹窗被拦」分支。
    // 这里补一个最小的 window.open，才能断言到「等待授权」那一步。
    const scope = globalThis as any;
    const originalOpen = scope.open;
    scope.open = () => ({ location: { href: "" }, close() {} });
    try {
      const bridge = fakeBridge({ authStatus: REQUIRED });
      const context = await openFirstCard(bridge);
      const connect = context.document.body.querySelector('[data-action="auth-connect"]') as any;
      expect(connect).toBeTruthy();
      expect(connect.textContent).toBe("登录后安装");
      // 弹窗盖住了目录顶部的连接条：这枚按钮必须是可点的入口，不能是一枚死按钮。
      expect(connect.disabled).toBe(false);
      expect(connect.className).toContain("sfstore__btn--auth");
      const state = context.document.body.querySelector('[data-role="foot-state"]') as any;
      expect(state.textContent).toContain("会打开商城授权页");

      dialogClick(context, '[data-action="auth-connect"]');
      await flush();
      expect(bridge.requests.some((entry) => entry.path === "/api/store/auth/start")).toBe(true);
      // 等待授权期间按钮禁用并改文案，避免重复开窗。
      const waiting = context.document.body.querySelector('[data-action="auth-waiting"]') as any;
      expect(waiting).toBeTruthy();
      expect(waiting.disabled).toBe(true);
      expect(waiting.textContent).toBe("等待商城授权…");
    } finally {
      scope.open = originalOpen;
    }
  });

  test("a connected store installs with the normal button", async () => {
    const bridge = fakeBridge({ authStatus: CONNECTED });
    const context = await openFirstCard(bridge);
    const bar = context.target.querySelector('[data-role="auth"]') as any;
    expect(bar.textContent).toContain("@ada");
    const button = context.document.body.querySelector('[data-action="install"]') as any;
    expect(button).toBeTruthy();
    expect(button.disabled).toBe(false);
  });

  test("disconnecting flips the open dialog back to the blocked button", async () => {
    const bridge = fakeBridge({ authStatus: CONNECTED });
    const context = await openFirstCard(bridge);
    expect((context.document.body.querySelector('[data-action="install"]') as any).disabled).toBe(false);

    // 连接条上的「断开连接」：状态机回到 idle，安装条必须立刻跟着变（onChange 联动）。
    click(context.target, '[data-action="auth-disconnect"]');
    await flush();

    const connect = context.document.body.querySelector('[data-action="auth-connect"]') as any;
    expect(connect).toBeTruthy();
    expect(connect.textContent).toBe("登录后安装");
  });

  test("en-US says the same thing in English", async () => {
    const bridge = fakeBridge({ authStatus: REQUIRED, locale: "en-US" });
    const context = await openFirstCard(bridge);
    const bar = context.target.querySelector('[data-role="auth"]') as any;
    expect(bar.textContent).toContain("Connect store");
    const connect = context.document.body.querySelector('[data-action="auth-connect"]') as any;
    expect(connect.textContent).toBe("Sign in to install");
    expect(bar.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

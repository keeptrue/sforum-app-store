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
  parseCatalog,
  parseInstallUrl,
  parseProduct,
  defaultPlatform,
  platformLabel,
  toCatalogItemView,
  toProductView,
} from "./logic";
import { installDom, toHTML } from "./test-dom";
import type { PageBridge, HostInstallRequest, HostInstallResult } from "./types";

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
};

function fakeBridge(options: {
  configured?: boolean;
  install?: boolean;
  installImpl?: (request: HostInstallRequest) => Promise<HostInstallResult>;
  locale?: unknown;
  catalog?: unknown;
  product?: unknown;
} = {}): FakeBridge {
  const requests: RequestLog[] = [];
  const toasts: FakeBridge["toasts"] = [];
  const navigations: string[] = [];
  const installCalls: HostInstallRequest[] = [];
  const bridge: FakeBridge = {
    requests,
    toasts,
    navigations,
    installCalls,
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
  return bridge;
}

function render(bridge: FakeBridge) {
  const documentShim = installDom();
  const target = documentShim.createElement("div");
  const cleanup = mount(target, bridge);
  return { document: documentShim, target, cleanup };
}

async function openFirstRow(bridge: FakeBridge) {
  const context = render(bridge);
  await flush();
  const row = context.target.querySelector('[data-slug="markdown"]');
  row?.dispatchEvent({ type: "click" });
  await flush();
  return context;
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
  test("catalog path carries only the filters that are set", () => {
    expect(buildCatalogPath({ query: "", channel: "stable", category: "", cursor: null })).toBe(
      "/api/store/catalog?channel=stable",
    );
    // 「含预发布」 must not send channel=beta: absent means both channels in the store API.
    expect(buildCatalogPath({ query: "", channel: "all", category: "", cursor: null })).toBe(
      "/api/store/catalog",
    );
    expect(
      buildCatalogPath({ query: "  mark down  ", channel: "all", category: "content", cursor: "c1" }),
    ).toBe("/api/store/catalog?q=mark+down&category=content&cursor=c1");
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
    // 开发版永远不被写成判词。
    expect(compatibilityView({ status: "unknown", estimated: true })).toEqual({
      label: "按开发版估算",
      tone: "warn",
    });
    expect(compatibilityView({ status: "incompatible", estimated: false })).toEqual({
      label: "不兼容",
      tone: "bad",
    });
    expect(
      compatibilityNote({ status: "unknown", estimated: false }, createCopy("zh-CN")),
    ).toContain("没有暴露版本号");
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

describe("mount", () => {
  test("exports apiVersion 1 and renders the catalog with real request params", async () => {
    expect(apiVersion).toBe(1);
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();

    expect(bridge.requests[0]).toEqual({ path: "/api/store/catalog?channel=stable", options: undefined });
    expect(target.querySelector('[data-role="count"]')!.textContent).toBe("共 2 个结果");
    expect(target.querySelectorAll(".sfstore__row").length).toBe(2);
    expect(target.querySelector('[data-role="stale"]')!.textContent).toContain("数据更新于");
    const html = toHTML(target);
    // 无判决不再逐行盖戳：未知状态由页级的一句说明表达。
    expect(html).not.toContain("未校验");
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "没有暴露版本号",
    );
    // 开发版估算与清单约束都留着：它们是事实，不是判词。
    expect(html).toContain("按开发版估算");
    expect(target.querySelectorAll(".sfstore__row-meta")[0]!.textContent).toContain(
      "sforum >=1.0.0 <2.0.0",
    );
    expect(html).not.toContain("<img");
  });

  test("switching the channel to 含预发布 drops the channel param", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    const select = target.querySelector('[data-role="channel"]') as any;
    select.value = "all";
    select.dispatchEvent({ type: "change" });
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog");
  });

  test("cursor pagination walks forward and back without page numbers", async () => {
    const bridge = fakeBridge();
    const { target } = render(bridge);
    await flush();
    const next = target.querySelector('[data-role="next"]') as any;
    expect(next.disabled).toBe(false);
    expect((target.querySelector('[data-role="prev"]') as any).disabled).toBe(true);

    next.dispatchEvent({ type: "click" });
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?channel=stable&cursor=cursor-2");

    (target.querySelector('[data-role="prev"]') as any).dispatchEvent({ type: "click" });
    await flush();
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/catalog?channel=stable");
    expect(toHTML(target)).not.toContain("第 2 页");
  });

  test("row click loads the product and renders README, versions, constraint, digest and selectors", async () => {
    const bridge = fakeBridge();
    const { target } = await openFirstRow(bridge);
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/product?slug=markdown");
    const html = toHTML(target);
    expect(html).toContain("&gt;=1.0.0 &lt;2.0.0");
    expect(html).toContain("9f2c1b7d4e5");
    expect(html).toContain("host.api · net.outbound");

    // README: the store's sanitised HTML is injected verbatim into its own container.
    expect(html).toContain("README");
    expect(html).toContain('class="sforum-store-readme"');
    expect(html).toContain("<h1>Markdown 增强</h1>");
    expect(html).toContain("<pre><code>bun test</code></pre>");
    expect(target.querySelector(".sforum-store-readme")!.innerHTML).toBe(README.html);

    // 「在 GitHub 查看」 opens the blob page in a new tab with a bare referrer.
    const source = target.querySelector(".sfstore__link") as any;
    expect(source.href).toBe(README.sourceUrl);
    expect(source.target).toBe("_blank");
    expect(source.rel).toBe("noreferrer noopener");
    expect(source.textContent).toBe("在 GitHub 查看");

    const versionSelect = target.querySelector('[data-action="version"]') as any;
    expect(versionSelect.value).toBe("1.4.2");
    const platformSelect = target.querySelector('[data-action="platform"]') as any;
    expect(platformSelect.value).toBe("linux/amd64");
  });

  test("a product without a README renders the placeholder, not an empty container", async () => {
    const bridge = fakeBridge({ product: THEME_PRODUCT });
    const { target } = render(bridge);
    await flush();
    target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();

    const html = toHTML(target);
    expect(html).toContain("README");
    expect(html).toContain("这个产品还没有可展示的 README。");
    expect(html).not.toContain("sforum-store-readme");
    expect(target.querySelector(".sforum-store-readme")).toBeNull();
    expect(target.querySelector(".sfstore__link")).toBeNull();
  });

  test("install posts install-url then calls installExtension with the exact object", async () => {
    const bridge = fakeBridge();
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="install"]');
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

    const html = toHTML(target);
    expect(html).toContain("已暂存");
    expect(html).toContain("启用与信任在 core 完成");
    expect(html).toContain("demo.markdown");
    expect(html).toContain("1.4.2");
    expect(html).toContain(SIGNED.sha256);
    expect(bridge.toasts[0]).toEqual({
      title: "已暂存",
      description: "启用与信任在 core 完成",
      kind: "success",
    });

    click(target, '[data-action="open-core"]');
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

    const { target } = render(bridge);
    await flush();
    target.querySelector('[data-slug="aurora"]')!.dispatchEvent({ type: "click" });
    await flush();
    click(target, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls[0]!.expectedType).toBe("theme");
    click(target, '[data-action="open-core"]');
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
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="install"]');
    await flush();
    const html = toHTML(target);
    expect(html).toContain("没有安装权限");
    expect(bridge.toasts.at(-1)).toEqual({ title: "没有安装权限", kind: "error" });
    expect((target.querySelector('[data-action="install"]') as any).disabled).toBe(false);
  });

  test("single flight: a second click while pending is ignored and explained", async () => {
    let release: (value: HostInstallResult) => void = () => {};
    const pending = new Promise<HostInstallResult>((resolve) => {
      release = resolve;
    });
    const bridge = fakeBridge({ installImpl: () => pending });
    const { target } = await openFirstRow(bridge);

    click(target, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls).toHaveLength(1);
    expect(toHTML(target)).toContain("安装期间不要关闭页面");

    click(target, '[data-action="install"]');
    await flush();
    expect(bridge.installCalls).toHaveLength(1);
    expect(toHTML(target)).toContain("已有安装在进行");

    release(RESULT);
    await flush();
    expect(toHTML(target)).toContain("已暂存");
  });

  test("without bridge.installExtension the page explains the limit and offers the signed URL", async () => {
    const bridge = fakeBridge({ install: false });
    const { target } = await openFirstRow(bridge);
    const html = toHTML(target);
    expect(html).toContain("当前宿主不支持页面内安装");
    expect(target.querySelector('[data-action="install"]')).toBeNull();
    expect(target.querySelector('[data-action="sign"]')).not.toBeNull();

    click(target, '[data-action="sign"]');
    await flush();
    const signedHtml = toHTML(target);
    expect(bridge.requests.at(-1)!.path).toBe("/api/store/install-url");
    expect(signedHtml).toContain("链接 30 分钟内有效");
    expect(signedHtml).toContain("在 core 的扩展安装页粘贴");
    expect(signedHtml).toContain(SIGNED.url);

    click(target, '[data-action="open-core-install"]');
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
    expect(bridge.requests.length).toBe(1);
  });

  test("cleanup removes the nodes it added and stops listening", async () => {
    const bridge = fakeBridge();
    const { target, cleanup } = await openFirstRow(bridge);
    expect(target.children.length).toBe(1);
    const row = target.querySelector('[data-slug="markdown"]')!;
    const before = bridge.requests.length;

    cleanup();
    expect(target.children.length).toBe(0);

    row.dispatchEvent({ type: "click" });
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

  test("forbidden claims never render", async () => {
    const bridge = fakeBridge();
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="install"]');
    await flush();
    const html = toHTML(target);
    for (const banned of ["已安装", "已更新", "已验证构建", "自动升级"]) {
      expect(html.includes(banned)).toBe(false);
    }
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
    expect(target.querySelector(".sfstore__title")!.textContent).toBe("App Store");
    expect((target.querySelector('[data-role="search"]') as any).placeholder).toBe(
      "Name, extension ID, or summary",
    );
    expect(target.querySelector('[data-role="count"]')!.textContent).toBe("2 results");
    expect(target.querySelector('[data-role="stale"]')!.textContent).toContain("Cached data from");
    expect(target.querySelector('[data-role="prev"]')!.textContent).toBe("Previous");
    expect(target.querySelector('[data-role="next"]')!.textContent).toBe("Next");
    expect(target.querySelector('[data-role="refresh"]')!.textContent).toBe("Refresh");

    const html = toHTML(target);
    expect(html).toContain("Catalog");
    expect(html).toContain("Plugin");
    expect(html).not.toContain("Not checked");
    expect(target.querySelector('[data-role="compat-note"]')!.textContent).toContain(
      "does not expose its version",
    );
    expect(html).toContain("Estimated from a dev build");
    expect(html).toContain("Any platform");
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
    const { target } = await openFirstRow(bridge);

    const html = toHTML(target);
    expect(html).toContain("Platforms: linux/amd64 · darwin/arm64");
    expect(html).toContain("Versions");
    expect(html).toContain("Version list");
    expect(html).toContain("sforum constraint");
    expect(html).toContain("Capabilities");
    expect(html).toContain("Digest");
    expect(html).toContain("Yanked");
    expect(html).toContain("README");
    expect(html).toContain("View on GitHub");
    expect(target.querySelector('[data-label="Version"]')).not.toBeNull();
    expect(target.querySelector('[data-label="Digest"]')).not.toBeNull();
    expect(target.querySelector('[data-action="install"]')!.textContent).toBe("Install to forum");

    click(target, '[data-action="install"]');
    await flush();

    const stagedHtml = toHTML(target);
    expect(stagedHtml).toContain("Staged");
    expect(stagedHtml).toContain("Enabling and trusting happen in core");
    expect(stagedHtml).toContain("Extension ID");
    expect(bridge.toasts[0]).toEqual({
      title: "Staged",
      description: "Enabling and trusting happen in core",
      kind: "success",
    });
    // Success means staged only: no "installed", "updated" or "verified build".
    for (const banned of ["installed", "updated", "verified build", "auto-upgrade", "auto upgrade"]) {
      expect(stagedHtml.toLowerCase().includes(banned)).toBe(false);
    }
  });

  test("en-US explains the legacy-host limit and hands out a signed link", async () => {
    const bridge = fakeBridge({ locale: "en-US", install: false });
    const { target } = await openFirstRow(bridge);
    const html = toHTML(target);
    expect(html).toContain("This host does not support in-page installs");
    expect(target.querySelector('[data-action="sign"]')!.textContent).toBe("Get a signed link");

    click(target, '[data-action="sign"]');
    await flush();
    const signedHtml = toHTML(target);
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
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="install"]');
    await flush();
    expect(toHTML(target)).toContain("Cancelled (leaving the page aborts the install)");
    expect(bridge.toasts.at(-1)).toEqual({
      title: "Cancelled (leaving the page aborts the install)",
      kind: "error",
    });
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
      expect(target.querySelector(".sfstore__title")!.textContent).toBe("应用商城");
      expect(target.querySelector('[data-role="count"]')!.textContent).toBe("共 2 个结果");
      expect(toHTML(target)).not.toContain("未校验");
      expect(target.querySelector('[data-role="prev"]')!.textContent).toBe("上一页");
    }
  });

  test("a bridge without locale or t never throws and stays on zh-CN", async () => {
    const bridge = fakeBridge();
    delete (bridge as Record<string, unknown>).locale;
    const { target } = render(bridge);
    await flush();
    expect(target.querySelector(".sfstore__title")!.textContent).toBe("应用商城");
    expect(toHTML(target)).toContain("刷新");
    expect(toHTML(target)).toContain("共 2 个结果");
  });
});

describe("copy completeness", () => {
  const CJK = /[\u4e00-\u9fff]/;

  test("an ASCII catalog leaves no Chinese in the en-US render", async () => {
    const bridge = fakeBridge({ locale: "en-US", catalog: ASCII_CATALOG, product: ASCII_PRODUCT });
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="install"]');
    await flush();

    const html = toHTML(target);
    expect(html).toContain("Staged");
    expect(html).toContain("Release notes 1.4.2");
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
    const { target } = await openFirstRow(bridge);
    click(target, '[data-action="sign"]');
    await flush();

    const html = toHTML(target);
    expect(html).toContain("Signed download link");
    expect(html).not.toMatch(CJK);
  });

  test("the same ASCII catalog still renders Chinese chrome for zh-CN", async () => {
    const bridge = fakeBridge({ catalog: ASCII_CATALOG, product: ASCII_PRODUCT });
    const { target } = await openFirstRow(bridge);
    const html = toHTML(target);
    expect(html).toMatch(CJK);
    expect(html).toContain("目录");
    expect(html).toContain("更新说明 1.4.2");
    expect(html).toContain("在 GitHub 查看");
    expect(target.querySelector('[data-action="install"]')!.textContent).toBe("安装到论坛");
  });
});

describe("product mark", () => {
  const ICON = "https://store.example.com/api/assets/8f".concat("a".repeat(62));

  const withIcon = () => ({
    ...CATALOG,
    items: CATALOG.items.map((item, index) =>
      index === 0 ? { ...item, iconUrl: ICON } : item,
    ),
  });

  // The DOM shim supports compound selectors only (`.class`, `[attr="v"]`), no descendant
  // combinator — hence the flat class lookups.
  test("a store-hosted icon is rendered as an absolute <img> inside the tile", async () => {
    const bridge = fakeBridge({ catalog: withIcon(), product: PRODUCT });
    const { target } = await openFirstRow(bridge);

    const image = target.querySelector(".sfstore__tile-img") as any;
    expect(image).not.toBeNull();
    expect(image.src).toBe(ICON);
    expect(image.alt).toBe("");
    expect(image.parentNode?.getAttribute("aria-hidden")).toBe("true");
    // The tile itself carries no text when an image occupies it.
    expect(image.parentNode?.textContent).toBe("");
  });

  test("a broken icon falls back to the letter tile instead of showing a broken image", async () => {
    const bridge = fakeBridge({ catalog: withIcon(), product: PRODUCT });
    const { target } = await openFirstRow(bridge);

    const image = target.querySelector(".sfstore__tile-img") as any;
    image.dispatchEvent({ type: "error" });
    await flush();

    expect(target.querySelector(".sfstore__tile-img")).toBeNull();
    expect(target.querySelector('[data-slug="markdown"]')!.textContent).toContain("M");
  });

  test("the detail header shows the same icon at the large size", async () => {
    const product = { product: { ...PRODUCT.product, iconUrl: ICON } };
    const bridge = fakeBridge({ product });
    const { target } = await openFirstRow(bridge);

    const images = target.querySelectorAll(".sfstore__tile-img") as any[];
    const large = images.find((image) => image.parentNode?.className.includes("sfstore__tile--lg"));
    expect(large).toBeDefined();
    expect(large.src).toBe(ICON);
  });

  test("no iconUrl means no <img> at all", async () => {
    const bridge = fakeBridge();
    const { target } = await openFirstRow(bridge);
    expect(target.querySelector(".sfstore__tile-img")).toBeNull();
  });
});

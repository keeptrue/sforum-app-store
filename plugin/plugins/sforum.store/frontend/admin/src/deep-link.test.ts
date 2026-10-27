// Deep-link tests: `?product=<slug>` opens the existing detail dialog on first mount.
// Runs with `bun test frontend/admin/src` and the minimal DOM shim in `test-dom.ts`.

import { afterEach, describe, expect, test } from "bun:test";

import { mount } from "./catalog";
import { readProductQuery } from "./deep-link";
import { installDom, toHTML } from "./test-dom";
import type { PageBridge } from "./types";

const CATALOG = {
  items: [],
  total: 0,
  nextCursor: null,
  compatibility: { status: "unknown" as const, estimated: false },
  stale: false,
  fetchedAt: "",
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
    platforms: [{ os: "linux", arch: "amd64" }],
    readme: null,
    releases: [
      {
        version: "1.4.2",
        channel: "stable" as const,
        publishedAt: "2026-10-20T08:00:00Z",
        sforumVersion: ">=1.0.0 <2.0.0",
        status: "published",
        digest: "9f2c1b7d4e5a6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
        assets: [{ os: "linux", arch: "amd64", filename: "demo.zip", size: 1024, sha256: "9f2c" }],
      },
    ],
  },
};

type RequestLog = { path: string; options?: Record<string, unknown> };

function multiArchProduct() {
  return {
    product: {
      ...PRODUCT.product,
      latestVersion: "2.0.0",
      releases: [
        {
          version: "2.0.0",
          channel: "stable" as const,
          publishedAt: "2026-10-22T08:00:00Z",
          sforumVersion: "",
          status: "published",
          digest: "b".repeat(64),
          assets: [{ os: "linux", arch: "amd64", filename: "demo.zip", size: 1024, sha256: "bbbb" }],
        },
        {
          version: "1.0.0",
          channel: "stable" as const,
          publishedAt: "2026-09-01T08:00:00Z",
          sforumVersion: "",
          status: "published",
          digest: "c".repeat(64),
          assets: [{ os: "darwin", arch: "arm64", filename: "demo.zip", size: 1024, sha256: "cccc" }],
        },
      ],
    },
  };
}

function fakeBridge(
  options: { catalog?: unknown; product?: unknown; install?: boolean } = {},
): PageBridge & { requests: RequestLog[] } {
  const requests: RequestLog[] = [];
  const bridge: PageBridge & { requests: RequestLog[] } = {
    requests,
    request: async (path: string, requestOptions?: Record<string, unknown>) => {
      requests.push({ path, options: requestOptions });
      if (path.startsWith("/api/store/catalog")) return options.catalog ?? CATALOG;
      if (path.startsWith("/api/store/product")) return options.product ?? PRODUCT;
      if (path === "/api/store/install-url") {
        return {
          url: "https://store.example.com/api/v1/download/demo.sig",
          sha256: "9f2c1b7d4e5a6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
          size: 1024,
          expiresAt: "2026-10-27T12:00:00Z",
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    toast: () => {},
    navigate: async () => {},
  };
  if (options.install) {
    bridge.installExtension = async () => ({
      extensionId: "demo.markdown",
      version: "1.0.0",
      type: "plugin",
      packageDigest: "c".repeat(64),
      upgraded: false,
      requiresTrust: false,
    });
  }
  return bridge;
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const hadLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

function setLocationSearch(search: string | null) {
  if (search === null) {
    if (hadLocation) Object.defineProperty(globalThis, "location", hadLocation);
    else delete (globalThis as Record<string, unknown>).location;
    return;
  }
  Object.defineProperty(globalThis, "location", {
    value: { search },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setLocationSearch(null);
});

async function mountWithSearch(
  search: string,
  options: { catalog?: unknown; product?: unknown; install?: boolean } = {},
) {
  setLocationSearch(search);
  const documentShim = installDom();
  const target = documentShim.createElement("div");
  const bridge = fakeBridge(options);
  const cleanup = mount(target, bridge);
  await flush();
  return { document: documentShim, target, bridge, cleanup };
}

describe("readProductQuery", () => {
  test("accepts a lower-case slug with or without the leading question mark", () => {
    expect(readProductQuery("?product=markdown")).toBe("markdown");
    expect(readProductQuery("product=markdown")).toBe("markdown");
    expect(readProductQuery("?channel=stable&product=aurora")).toBe("aurora");
    // 2..64 字符，连字符在中间合法。
    expect(readProductQuery("?product=ab")).toBe("ab");
    expect(readProductQuery(`?product=a${"-b".repeat(31)}`)).toBe(`a${"-b".repeat(31)}`);
  });

  test("trims padding but rejects values that do not match the backend slug rule", () => {
    expect(readProductQuery("?product=%20markdown%20")).toBe("markdown");
    expect(readProductQuery("?product=Markdown")).toBe("");
    expect(readProductQuery("?product=markdown_extra")).toBe("");
    expect(readProductQuery("?product=-markdown")).toBe("");
    expect(readProductQuery("?product=markdown--")).toBe("markdown--");
    expect(readProductQuery("?product=a")).toBe("");
    expect(readProductQuery(`?product=${"a".repeat(65)}`)).toBe("");
    expect(readProductQuery("?product=markdown%2Fbeta")).toBe("");
  });

  test("returns an empty string for missing, empty, malformed or non-string input", () => {
    expect(readProductQuery("")).toBe("");
    expect(readProductQuery("?")).toBe("");
    expect(readProductQuery("?product=")).toBe("");
    expect(readProductQuery("?product=%20%20")).toBe("");
    expect(readProductQuery("?other=markdown")).toBe("");
    expect(readProductQuery("?product=%E0%A4%A")).toBe("");
    expect(readProductQuery(undefined as unknown as string)).toBe("");
    expect(readProductQuery(null as unknown as string)).toBe("");
    expect(readProductQuery({ toString: () => "?product=markdown" } as unknown as string)).toBe("");
  });
});

describe("product deep link on mount", () => {
  test("opens the existing detail dialog and requests exactly that product", async () => {
    const context = await mountWithSearch("?product=markdown");
    try {
      expect(context.bridge.requests.map((entry) => entry.path)).toContain(
        "/api/store/product?slug=markdown",
      );
      const html = toHTML(context.document.body);
      expect(html).toContain("Markdown 增强");
      expect(html).toContain("1.4.2");
      // 详情弹窗用的是既有 dialog 容器，而不是另造一层。
      expect(context.document.body.querySelector(".sfstore__overlay")).not.toBeNull();
    } finally {
      context.cleanup();
    }
  });

  test("does not request a product when the query is missing or invalid", async () => {
    for (const search of ["", "?product=Markdown", "?product=-x", "?channel=stable"]) {
      const context = await mountWithSearch(search);
      try {
        expect(context.bridge.requests.some((entry) => entry.path.startsWith("/api/store/product"))).toBe(false);
        expect(context.document.body.querySelector(".sfstore__overlay")).toBeNull();
      } finally {
        context.cleanup();
      }
    }
  });


  test("reselects the version and asset platform once the catalog target arrives", async () => {
    // 深链与目录并行：详情可能先落地，此时还没有宿主 target，只能选中第一项资产。
    // 目录带回 darwin/arm64 后必须重算，否则多架构发布会按 linux 资产去签名。
    const catalog = { ...CATALOG, target: { os: "darwin", arch: "arm64" } };
    const context = await mountWithSearch("?product=markdown", { catalog, product: multiArchProduct() });
    try {
      const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
      expect(versionSelect).not.toBeNull();
      expect(versionSelect.value).toBe("1.0.0");
    } finally {
      context.cleanup();
    }
  });

  test("a normal card click keeps the target-based version and asset choice", async () => {
    const catalog = {
      ...CATALOG,
      items: [
        {
          slug: "markdown",
          extensionId: "demo.markdown",
          name: "Markdown 增强",
          kind: "plugin" as const,
          summary: "补齐 Markdown 语法。",
          category: "content",
          latestVersion: "2.0.0",
          sforumVersion: "",
          platforms: [
            { os: "linux", arch: "amd64" },
            { os: "darwin", arch: "arm64" },
          ],
          compatibility: { status: "unknown" as const, estimated: true },
        },
      ],
      total: 1,
      target: { os: "darwin", arch: "arm64" },
    };
    const product = multiArchProduct();
    const context = await mountWithSearch("", { catalog, product, install: true });
    try {
      const card = context.target.querySelector('[data-slug="markdown"]') as any;
      expect(card).not.toBeNull();
      card.dispatchEvent({ type: "click" });
      await flush();

      const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
      expect(versionSelect.value).toBe("1.0.0");

      const install = context.document.body.querySelector('[data-action="install"]') as any;
      expect(install).not.toBeNull();
      install.dispatchEvent({ type: "click" });
      await flush();
      const signed = context.bridge.requests.find((entry) => entry.path === "/api/store/install-url");
      expect(signed?.options).toEqual({
        method: "POST",
        body: { slug: "markdown", version: "1.0.0", os: "darwin", arch: "arm64" },
      });
    } finally {
      context.cleanup();
    }
  });

  test("a later catalog reload keeps the version the operator picked", async () => {
    const catalog = {
      ...CATALOG,
      target: { os: "darwin", arch: "arm64" },
    };
    const context = await mountWithSearch("?product=markdown", { catalog, product: multiArchProduct() });
    try {
      const versionSelect = context.document.body.querySelector('[data-action="version"]') as any;
      expect(versionSelect.value).toBe("1.0.0");
      versionSelect.value = "2.0.0";
      versionSelect.dispatchEvent({ type: "change" });
      await flush();

      // 搜索会触发一次目录重载：target 没变，就不该把手选的版本重置。
      const search = context.target.querySelector('[data-role="search"]') as any;
      search.value = "mark";
      search.dispatchEvent({ type: "input" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await flush();

      expect(context.document.body.querySelector('[data-action="version"]')!.value).toBe("2.0.0");
    } finally {
      context.cleanup();
    }
  });

  test("keeps the catalog request independent from the detail request", async () => {
    const context = await mountWithSearch("?product=markdown");
    try {
      const paths = context.bridge.requests.map((entry) => entry.path);
      expect(paths.filter((path) => path.startsWith("/api/store/catalog"))).toHaveLength(1);
      expect(paths.filter((path) => path.startsWith("/api/store/product"))).toHaveLength(1);
      // 深链只读查询串：不写 history，也不改卡片点击 URL。
      expect(context.bridge.requests.every((entry) => entry.options === undefined)).toBe(true);
    } finally {
      context.cleanup();
    }
  });
});

// 连接商城的页面侧状态机：开窗时机、轮询节奏、超时、错误映射。
//
// 这些用例不渲染整页：`createAuthController` 自带连接条，注入假 request / 假定时器就能
// 把「同步开窗」「2 秒轮询」「5 分钟截止」「断开」逐条钉住。整页层面的连接条与安装条
// 联动在 catalog.test.ts。

import { describe, expect, test } from "bun:test";

import {
  AUTH_DISCONNECT_PATH,
  AUTH_POLL_PATH,
  AUTH_START_PATH,
  AUTH_STATUS_PATH,
  authErrorMessage,
  createAuthController,
  shortCode,
} from "./auth";
import { createCopy } from "./copy";
import { installDom } from "./test-dom";

const copy = createCopy("zh-CN");

type Call = { path: string; options?: Record<string, unknown> };

/** 手动时钟 + 手动定时器：轮询节奏与截止时间都由用例推进。 */
function harness(
  responses: (call: Call, context: { now: number }) => unknown,
  options: { openWindow?: () => { location: { href: string }; close?: () => void } | null } = {},
) {
  installDom();
  const calls: Call[] = [];
  let clock = 1_000_000;
  let pending: Array<{ run: () => void; at: number }> = [];
  let openCount = 0;
  const tabs: Array<{ location: { href: string }; close: () => void; closed: boolean }> = [];

  const controller = createAuthController({
    copy,
    request: async <T = unknown>(path: string, requestOptions?: Record<string, unknown>): Promise<T> => {
      const call = { path, options: requestOptions };
      calls.push(call);
      const value = responses(call, { now: clock });
      if (value instanceof Error) throw value;
      return value as T;
    },
    openWindow:
      options.openWindow ??
      (() => {
        openCount += 1;
        const tab = {
          location: { href: "about:blank" },
          closed: false,
          close() {
            tab.closed = true;
          },
        };
        tabs.push(tab);
        return tab;
      }),
    setTimer: (run, ms) => {
      const entry = { run, at: clock + ms };
      pending.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      pending = pending.filter((entry) => entry !== handle);
    },
    now: () => clock,
  });

  return {
    controller,
    calls,
    tabs,
    opens: () => openCount,
    /** 推进时间并触发到点的定时器（一次只跑一轮，轮询会自己排下一轮）。 */
    async advance(ms: number) {
      clock += ms;
      const due = pending.filter((entry) => entry.at <= clock);
      pending = pending.filter((entry) => entry.at > clock);
      for (const entry of due) entry.run();
      await flush();
    },
    scheduled: () => pending.length,
    now: () => clock,
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function httpError(code: string, status = 400) {
  const error = new Error(code) as Error & { status?: number; data?: unknown };
  error.status = status;
  error.data = { code, message: code };
  return error;
}

describe("status probe", () => {
  test("anonymous mode hides the bar and never blocks an install", async () => {
    const h = harness(() => ({ mode: "anonymous", connected: false, account: null, expiresAt: null }));
    await h.controller.load();
    expect(h.calls.map((call) => call.path)).toEqual([AUTH_STATUS_PATH]);
    expect(h.controller.snapshot().mode).toBe("anonymous");
    expect(h.controller.isBlocking()).toBe(false);
    expect(h.controller.element.hidden).toBe(true);
  });

  test("account_required without a credential shows the connect bar", async () => {
    const h = harness(() => ({ mode: "account_required", connected: false, account: null, expiresAt: null }));
    await h.controller.load();
    expect(h.controller.isBlocking()).toBe(true);
    expect(h.controller.element.hidden).toBe(false);
    expect(h.controller.element.textContent).toContain("商城要求登录");
    expect(h.controller.element.textContent).toContain("连接商城");
  });

  test("a connected credential renders the account and the expiry", async () => {
    const h = harness(() => ({
      mode: "account_required",
      connected: true,
      account: { id: "acc-1", issuerKey: "forum", username: "ada", displayName: "Ada", avatarUrl: "" },
      expiresAt: "2026-11-26T00:00:00Z",
    }));
    await h.controller.load();
    expect(h.controller.isBlocking()).toBe(false);
    const text = h.controller.element.textContent ?? "";
    expect(text).toContain("@ada");
    // 到期时间按页面统一的本地时间格式显示（不是 ISO 串）。
    expect(text).toContain("令牌有效至 2026-11-26");
    expect(text).not.toContain("2026-11-26T00:00:00Z");
    expect(text).toContain("断开连接");
  });

  test("an old store is unsupported and does not block", async () => {
    const h = harness(() => ({ mode: "unsupported", connected: false, account: null, expiresAt: null }));
    await h.controller.load();
    expect(h.controller.element.hidden).toBe(true);
    expect(h.controller.isBlocking()).toBe(false);
  });

  test("an unreadable status degrades to anonymous instead of breaking the page", async () => {
    const h = harness(() => httpError("not_configured", 503));
    await h.controller.load();
    expect(h.controller.snapshot().phase).toBe("error");
    expect(h.controller.snapshot().mode).toBe("anonymous");
    expect(h.controller.isBlocking()).toBe(false);
  });
});

describe("connect flow", () => {
  test("opens the tab before the request and navigates it to the authorize url", async () => {
    let openedBeforeRequest = false;
    const h = harness(
      (call) => {
        if (call.path === AUTH_STATUS_PATH) {
          return { mode: "account_required", connected: false, account: null, expiresAt: null };
        }
        if (call.path === AUTH_START_PATH) {
          // 开窗必须发生在这次请求之前：await 之后再 open 会被拦截。
          openedBeforeRequest = h.opens() === 1;
          return {
            requestId: "11111111-1111-4111-8111-111111111111",
            authorizeUrl: "https://store.example.test/connect/11111111-1111-4111-8111-111111111111",
            expiresIn: 300,
            interval: 2,
          };
        }
        return { status: "pending" };
      },
    );
    await h.controller.load();
    await h.controller.connect();

    expect(openedBeforeRequest).toBe(true);
    expect(h.tabs[0]?.location.href).toBe(
      "https://store.example.test/connect/11111111-1111-4111-8111-111111111111",
    );
    expect(h.controller.snapshot().phase).toBe("waiting");
    expect(h.controller.snapshot().code).toBe("11111111");
    expect(h.controller.element.textContent).toContain("等待你允许");
    expect(h.scheduled()).toBe(1);
  });

  test("polls at the advertised interval until the store says connected", async () => {
    let polls = 0;
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return {
          requestId: "22222222-2222-4222-8222-222222222222",
          authorizeUrl: "https://store.example.test/connect/22222222-2222-4222-8222-222222222222",
          expiresIn: 300,
          interval: 2,
        };
      }
      polls += 1;
      if (polls < 2) return { status: "pending" };
      return {
        status: "connected",
        account: { id: "acc-1", issuerKey: "forum", username: "ada", displayName: "Ada", avatarUrl: "" },
        expiresAt: "2026-11-26T00:00:00Z",
      };
    });
    await h.controller.load();
    await h.controller.connect();

    await h.advance(2_000);
    expect(polls).toBe(1);
    expect(h.controller.snapshot().phase).toBe("waiting");

    await h.advance(2_000);
    expect(polls).toBe(2);
    expect(h.controller.snapshot().phase).toBe("connected");
    expect(h.controller.isBlocking()).toBe(false);
    expect(h.scheduled()).toBe(0);
    expect(h.controller.element.textContent).toContain("@ada");
  });

  test("a denied request explains itself and stops polling", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return { requestId: "33333333-3333-4333-8333-333333333333", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      }
      return { status: "denied", account: null, expiresAt: null };
    });
    await h.controller.load();
    await h.controller.connect();
    await h.advance(2_000);
    expect(h.controller.snapshot().phase).toBe("error");
    expect(h.controller.element.textContent).toContain("驳回");
    expect(h.scheduled()).toBe(0);
    expect(h.controller.isBlocking()).toBe(true);
  });

  test("an expired or consumed request asks for a new one", async () => {
    for (const status of ["expired", "consumed"]) {
      const h = harness((call) => {
        if (call.path === AUTH_STATUS_PATH) {
          return { mode: "account_required", connected: false, account: null, expiresAt: null };
        }
        if (call.path === AUTH_START_PATH) {
          return { requestId: "44444444-4444-4444-8444-444444444444", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
        }
        return { status, account: null, expiresAt: null };
      });
      await h.controller.load();
      await h.controller.connect();
      await h.advance(2_000);
      expect(h.controller.snapshot().phase).toBe("error");
      expect(h.controller.element.textContent).toMatch(/重新连接/);
      expect(h.scheduled()).toBe(0);
    }
  });

  test("the five minute deadline stops a request the operator abandoned", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return { requestId: "55555555-5555-4555-8555-555555555555", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      }
      return { status: "pending", account: null, expiresAt: null };
    });
    await h.controller.load();
    await h.controller.connect();
    await h.advance(2_000);
    expect(h.controller.snapshot().phase).toBe("waiting");
    // 越过 5 分钟：下一次到点不再发请求，直接判过期。
    const before = h.calls.length;
    await h.advance(301_000);
    expect(h.calls.length).toBe(before);
    expect(h.controller.snapshot().phase).toBe("error");
    expect(h.controller.element.textContent).toContain("过期");
  });

  test("a failed start writes the reason into the already-open tab", async () => {
    // 先开窗后请求：请求失败时那个标签页还是 about:blank。它必须被写成一句人话，
    // 否则操作者手里只剩一张白纸，看不出是「连接失败」还是「页面坏了」。
    let written = "";
    let closed = false;
    const h = harness(
      (call) => {
        if (call.path === AUTH_STATUS_PATH) {
          return { mode: "account_required", connected: false, account: null, expiresAt: null };
        }
        return httpError("upstream_error", 502);
      },
      {
        openWindow: () => ({
          location: { href: "about:blank" },
          close: () => {
            closed = true;
          },
          document: {
            title: "",
            body: {
              set textContent(value: string) {
                written = value;
              },
            },
          },
        }),
      },
    );
    await h.controller.load();
    await h.controller.connect();
    expect(closed).toBe(false);
    expect(written).toContain("连接商城没有完成");
    // 502 且没有插件错误码：说的是「暂时不可用」，不是一句什么都没说的「失败」。
    expect(written).toContain("暂时不可用");
    expect(h.controller.snapshot().phase).toBe("error");
  });

  test("when the tab cannot be written it is closed instead", async () => {
    let closed = false;
    const h = harness(
      (call) => {
        if (call.path === AUTH_STATUS_PATH) {
          return { mode: "account_required", connected: false, account: null, expiresAt: null };
        }
        return httpError("upstream_error", 502);
      },
      {
        openWindow: () => ({
          location: { href: "about:blank" },
          close: () => {
            closed = true;
          },
          // 没有 document：模拟跨源/只读文档
        }),
      },
    );
    await h.controller.load();
    await h.controller.connect();
    expect(closed).toBe(true);
  });

  test("a blocked popup is reported instead of silently waiting", async () => {
    const h = harness(
      (call) => {
        if (call.path === AUTH_STATUS_PATH) {
          return { mode: "account_required", connected: false, account: null, expiresAt: null };
        }
        return { requestId: "66666666-6666-4666-8666-666666666666", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      },
      { openWindow: () => null },
    );
    await h.controller.load();
    await h.controller.connect();
    expect(h.controller.snapshot().phase).toBe("error");
    expect(h.controller.element.textContent).toContain("拦截");
    expect(h.scheduled()).toBe(0);
  });

  test("cancel stops the poll without touching the store", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return { requestId: "77777777-7777-4777-8777-777777777777", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      }
      return { status: "pending", account: null, expiresAt: null };
    });
    await h.controller.load();
    await h.controller.connect();
    const before = h.calls.length;
    // 连接条上的「取消」按钮。
    const cancel = h.controller.element.querySelector('[data-action="auth-cancel"]') as any;
    cancel.dispatchEvent({ type: "click" });
    await flush();
    expect(h.controller.snapshot().phase).toBe("idle");
    expect(h.scheduled()).toBe(0);
    expect(h.calls.length).toBe(before);
  });

  test("a secret write failure is surfaced with the host hint", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return { requestId: "88888888-8888-4888-8888-888888888888", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      }
      return httpError("secret_write_failed", 502);
    });
    await h.controller.load();
    await h.controller.connect();
    await h.advance(2_000);
    expect(h.controller.snapshot().phase).toBe("error");
    expect(h.controller.element.textContent).toContain("secret");
  });
});

describe("disconnect", () => {
  test("clears the credential and returns to the connect state", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return {
          mode: "account_required",
          connected: true,
          account: { id: "acc-1", issuerKey: "forum", username: "ada", displayName: "Ada", avatarUrl: "" },
          expiresAt: "2026-11-26T00:00:00Z",
        };
      }
      if (call.path === AUTH_DISCONNECT_PATH) return { connected: false, revoked: true };
      throw new Error(`unexpected ${call.path}`);
    });
    await h.controller.load();
    expect(h.controller.isBlocking()).toBe(false);

    await h.controller.disconnect();
    expect(h.calls.some((call) => call.path === AUTH_DISCONNECT_PATH)).toBe(true);
    expect(h.controller.snapshot().phase).toBe("idle");
    expect(h.controller.snapshot().connected).toBe(false);
    expect(h.controller.isBlocking()).toBe(true);
  });
});

describe("copy and helpers", () => {
  test("short code matches the one on the store approval page", () => {
    expect(shortCode("abcdef12-3456-4789-8abc-def012345678")).toBe("ABCDEF12");
  });

  test("a host-level failure without a plugin code still says something specific", () => {
    // 插件重启/路由未就绪时宿主回 5xx，信封里没有插件错误码：不能落到「失败了」。
    expect(authErrorMessage("", copy, "", 503)).toContain("暂时不可用");
    expect(authErrorMessage("", copy, "", 403)).toContain("插件管理权限");
    expect(authErrorMessage("", copy, "", 429)).toContain("太频繁");
  });

  test("every failure code has its own sentence in both locales", () => {
    const codes = [
      "not_configured",
      "auth_unsupported",
      "auth_not_required",
      "request_unknown",
      "secret_write_failed",
      "login_required",
      "something_else",
    ];
    for (const code of codes) {
      const zh = authErrorMessage(code, copy);
      const en = authErrorMessage(code, createCopy("en-US"));
      expect(zh.length).toBeGreaterThan(4);
      expect(en.length).toBeGreaterThan(4);
      expect(zh).not.toBe(en);
    }
  });

  test("en-US never falls back to Chinese for the connection bar", async () => {
    const h = harness(() => ({ mode: "account_required", connected: false, account: null, expiresAt: null }));
    const english = createAuthController({
      copy: createCopy("en-US"),
      request: async () => ({ mode: "account_required", connected: false, account: null, expiresAt: null }),
    });
    await english.load();
    const text = english.element.textContent ?? "";
    expect(text).toContain("Connect store");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
    english.destroy();
    await h.controller.load();
    expect(h.controller.element.textContent).toContain("连接商城");
  });
});

describe("lifecycle", () => {
  test("destroy stops a pending poll", async () => {
    const h = harness((call) => {
      if (call.path === AUTH_STATUS_PATH) {
        return { mode: "account_required", connected: false, account: null, expiresAt: null };
      }
      if (call.path === AUTH_START_PATH) {
        return { requestId: "99999999-9999-4999-8999-999999999999", authorizeUrl: "https://s/x", expiresIn: 300, interval: 2 };
      }
      return { status: "pending", account: null, expiresAt: null };
    });
    await h.controller.load();
    await h.controller.connect();
    h.controller.destroy();
    expect(h.scheduled()).toBe(0);
  });
});

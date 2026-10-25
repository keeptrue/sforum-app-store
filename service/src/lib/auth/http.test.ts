import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { isSameOrigin } from "./http";

const publicUrl = "https://store.example.com";

function request(origin?: string, host?: string): Request {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (host !== undefined) headers.set("host", host);
  return new Request(`${publicUrl}/api/auth/logout`, { method: "POST", headers });
}

let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  // A rejection is expected in most cases here; the log line is for operators, not the suite.
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => warn.mockRestore());

describe("isSameOrigin", () => {
  test("accepts the configured public origin", () => {
    expect(isSameOrigin(request(publicUrl), publicUrl)).toBe(true);
  });

  test("accepts a request without an Origin header", () => {
    // Same-site GETs and non-browser clients omit it; the session cookie still gates the act.
    expect(isSameOrigin(request(), publicUrl)).toBe(true);
  });

  test("rejects a tunnel host while publicUrl still points at loopback", () => {
    // The exact mismatch a tunnel produces: the browser speaks from the public hostname and
    // the process still believes it lives on 127.0.0.1. Every mutation would 403.
    expect(
      isSameOrigin(request("https://demo.trycloudflare.com"), "http://127.0.0.1:4000"),
    ).toBe(false);
  });

  test("rejects a scheme downgrade on the same host", () => {
    expect(isSameOrigin(request("http://store.example.com"), publicUrl)).toBe(false);
  });

  test("rejects a malformed origin", () => {
    expect(isSameOrigin(request("not a url"), publicUrl)).toBe(false);
  });

  test("accepts the origin the request itself arrived on", () => {
    // A console save changes the public URL; the next mutation still comes from the address
    // the operator is standing on. Rejecting it would lock them out of the page that fixes it.
    expect(
      isSameOrigin(
        request("https://demo.trycloudflare.com", "demo.trycloudflare.com"),
        "http://127.0.0.1:4000",
      ),
    ).toBe(true);
  });

  test("accepts a forwarded host, which is what a proxy reports", () => {
    const headers = new Headers({
      origin: "https://demo.trycloudflare.com",
      host: "127.0.0.1:4000",
      "x-forwarded-host": "demo.trycloudflare.com",
      "x-forwarded-proto": "https",
    });
    const proxied = new Request("http://127.0.0.1:4000/api/auth/logout", {
      method: "POST",
      headers,
    });
    expect(isSameOrigin(proxied, "http://127.0.0.1:4000")).toBe(true);
  });

  test("rejects an origin that is neither configured nor where the request arrived", () => {
    expect(
      isSameOrigin(request("https://evil.example", "store.example.com"), publicUrl),
    ).toBe(false);
  });

  test("logs both sides so an operator can tell proxy rewrite from stale config", () => {
    isSameOrigin(request("https://demo.trycloudflare.com"), "http://127.0.0.1:4000");
    expect(warn).toHaveBeenCalledWith("[auth] rejected a cross-origin mutation", {
      expected: "http://127.0.0.1:4000",
      requestOrigin: null,
      actual: "https://demo.trycloudflare.com",
    });
  });
});

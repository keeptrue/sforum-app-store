import type { components } from "@/lib/api-types";
import { getDb } from "@/db/client";
import { ConfigError, cookieName, getConfig } from "@/lib/config";
import { getRuntimeConfig } from "@/lib/settings/runtime";

type Health = components["schemas"]["Health"];

export const dynamic = "force-dynamic";

/**
 * Liveness probe, plus the one piece of configuration that is worth checking from outside.
 *
 * The public URL anchors every browser-visible absolute URL this service emits — OAuth
 * callback, error redirects, download short links, and the baseline `isSameOrigin` compares
 * against. A deployment reached through a proxy or tunnel while that value still points at
 * loopback produces "login does nothing" with no error anywhere, so the resolved value is
 * reported here with the layer that answered (`database` = 系统设置, `env` = the seed) and can
 * be compared against the address bar in one request.
 *
 * `downloadAuthMode` is reported for the same reason: an operator who flipped the install gate
 * in the console needs to confirm from outside that every process picked it up, and the mode
 * decides whether an old plugin starts receiving 401s.
 *
 * Configuration is optional for the probe: a process that answers is alive even if it cannot
 * serve, and turning a missing env var — or an unreachable database — into a 500 would hide
 * the difference between "wrong config" and "not listening".
 */
export async function GET() {
  const body: Health = {
    status: "ok",
    version: process.env.STORE_BUILD_VERSION ?? "dev",
    commit: process.env.STORE_BUILD_COMMIT ?? "local",
    time: new Date().toISOString(),
  };

  try {
    const config = getConfig();
    body.nodeEnv = config.nodeEnv;
    try {
      const runtime = await getRuntimeConfig(getDb(), { fresh: true });
      body.publicUrl = runtime.publicUrl;
      body.publicUrlSource = runtime.publicUrlSource;
      body.settingsUpdatedAt = runtime.updatedAt?.toISOString() ?? null;
      body.cookieSecure = runtime.cookieSecure;
      body.sessionCookie = cookieName(runtime.cookieSecure, "session");
      body.downloadAuthMode = runtime.downloadAuthMode;
      body.downloadAuthModeSource = runtime.downloadAuthModeSource;
      if (runtime.warnings.length > 0) body.configWarning = runtime.warnings.join(" · ");
    } catch (error) {
      // Database unreachable (or the settings row unreadable): report the seed, and say so.
      // A probe that 500s here would look like a dead process instead of a dead database.
      body.publicUrl = config.publicUrlSeed;
      body.publicUrlSource = "env";
      body.cookieSecure = config.publicUrlSeed.startsWith("https:");
      body.sessionCookie = cookieName(body.cookieSecure, "session");
      body.downloadAuthMode = config.downloadAuthMode;
      body.downloadAuthModeSource = "env";
      body.configWarning =
        error instanceof ConfigError
          ? error.message
          : "store_settings 读取失败，已回退到 STORE_PUBLIC_URL";
    }
  } catch (error) {
    body.configError =
      error instanceof ConfigError ? error.message : "config_unreadable";
  }

  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

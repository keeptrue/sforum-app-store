/**
 * `settings:public-url` — set or clear the public base URL without the console.
 *
 * The console page (`/<admin-path>/settings/general`) is the normal way. This exists for the
 * two cases the console cannot cover:
 *
 * - **lockout recovery**: the saved value made the console unreachable (wrong scheme, wrong
 *   host, or a TLS proxy that is not up yet). The page is not the place that can fix it.
 * - **first boot on a new host**: a container that has never had an operator sign in.
 *
 *   bun run settings:public-url -- --show
 *   bun run settings:public-url -- --set https://store.example.com
 *   bun run settings:public-url -- --clear
 *
 * `--clear` drops the row so `STORE_PUBLIC_URL` takes over again — the value that was in effect
 * before anyone touched the console.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDb, getDb } from "@/db/client";
import { storeSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import { invalidateRuntimeConfig, getRuntimeConfig } from "@/lib/settings/runtime";
import { normalizePublicUrl } from "@/lib/settings/validate";
import { parseEnvText } from "@/lib/admin/password-reset";

const USAGE = `用法：
  bun run settings:public-url -- --show
  bun run settings:public-url -- --set <url>
  bun run settings:public-url -- --clear

  --show   打印当前生效的对外地址与它来自哪一层
  --set    写入 store_settings.public_url（保存后立即生效，不需要重启）
  --clear  删除该行，回到 STORE_PUBLIC_URL 种子
`;

type Args =
  | { action: "show" }
  | { action: "set"; value: string }
  | { action: "clear" }
  | { action: "help" };

function parseArgs(argv: string[]): Args {
  const [flag, ...rest] = argv;
  if (!flag || flag === "--help" || flag === "-h") return { action: "help" };
  if (flag === "--show") return { action: "show" };
  if (flag === "--clear") return { action: "clear" };
  if (flag === "--set") {
    const value = rest.join(" ").trim();
    if (!value) throw new Error("--set 需要一个 URL");
    return { action: "set", value };
  }
  throw new Error(`未知参数：${flag}`);
}

/** Fills `DATABASE_URL` from a local env file when the shell did not export it. */
function loadLocalEnv(): void {
  const candidates = [".env.local", "service/.env.local", ".env", "service/.env"];
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (!existsSync(path)) continue;
    const values = parseEnvText(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (args.action === "help") {
    console.log(USAGE);
    return;
  }

  const db = getDb();

  if (args.action === "show") {
    const runtime = await getRuntimeConfig(db, { fresh: true });
    console.log(`生效地址：${runtime.publicUrl}`);
    console.log(
      `来源：${runtime.publicUrlSource === "database" ? "后台设置（store_settings）" : "STORE_PUBLIC_URL 种子"}`,
    );
    if (runtime.updatedAt) console.log(`上次修改：${runtime.updatedAt.toISOString()}`);
    for (const warning of runtime.warnings) console.warn(`警告：${warning}`);
    return;
  }

  if (args.action === "set") {
    const publicUrl = normalizePublicUrl(args.value);
    const now = new Date();
    const [row] = await db
      .select({ id: storeSettings.id })
      .from(storeSettings)
      .where(eq(storeSettings.id, "default"))
      .limit(1);

    if (row) {
      // `updated_by_admin_id` is left as-is: this write has no administrator behind it, and
      // stamping null would erase who last touched the row through the console.
      await db
        .update(storeSettings)
        .set({ publicUrl, updatedAt: now })
        .where(eq(storeSettings.id, "default"));
    } else {
      await db.insert(storeSettings).values({ id: "default", publicUrl, updatedAt: now });
    }

    invalidateRuntimeConfig();
    console.log(`已写入：${publicUrl}`);
    console.log("当前进程下一次请求即生效；其它进程最多 15 秒收敛。");
    return;
  }

  const [row] = await db
    .select({ id: storeSettings.id })
    .from(storeSettings)
    .where(eq(storeSettings.id, "default"))
    .limit(1);
  if (!row) {
    console.log("没有 store_settings 行：已经在使用 STORE_PUBLIC_URL 种子。");
  } else {
    await db.delete(storeSettings).where(eq(storeSettings.id, "default"));
    invalidateRuntimeConfig();
    console.log(`已删除该行，对外地址回到 STORE_PUBLIC_URL：${getConfig().publicUrlSeed}`);
  }
}

try {
  await main();
} finally {
  await closeDb();
}

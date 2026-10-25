/**
 * `admin:reset-password` — scriptable recovery for a store-local administrator.
 *
 * The interactive `admin:password` command assumes a TTY and two human answers. This one is the
 * runbook / container / CI shape: it can read the password from a pipe, mint a random one, or
 * just list the accounts, and it never writes a password into shell history or a log.
 *
 *   cd service && bun run admin:reset-password -- <username>
 *   bun run admin:reset-password -- <username> --generate
 *   printf '%s\n' "$NEW_PASSWORD" | bun run admin:reset-password -- <username> --password-stdin
 *   bun run admin:reset-password -- --list
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { closeDb, getDb } from "@/db/client";
import {
  AdminResetError,
  USAGE,
  findAdminByUsername,
  generatePassword,
  listAdminRows,
  parseEnvText,
  parseResetArgs,
  resetAdminPassword,
  type AdminRow,
  type ResetArgs,
} from "@/lib/admin/password-reset";
import { PASSWORD_MIN } from "@/lib/admin/password";

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

function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const input = process.stdin;
    const output = process.stdout;
    output.write(question);

    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding("utf8");

    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          input.setRawMode?.(wasRaw ?? false);
          input.pause();
          input.removeListener("data", onData);
          output.write("\n");
          resolvePromise(value);
          return;
        }
        if (char === "\u0003") {
          input.setRawMode?.(wasRaw ?? false);
          output.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

async function readStdinPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const line = text.split(/\r?\n/).find((value) => value.length > 0) ?? "";
  return line;
}

async function resolvePassword(args: ResetArgs): Promise<string> {
  if (args.source === "generated") return generatePassword();
  if (args.source === "stdin") {
    const password = await readStdinPassword();
    if (!password) throw new AdminResetError("invalid_password", "标准输入里没有读到密码");
    return password;
  }
  if (!process.stdin.isTTY) {
    throw new AdminResetError(
      "invalid_password",
      "当前不是终端，无法隐藏输入；请改用 --password-stdin 或 --generate",
    );
  }
  const password = await promptHidden(`新密码（至少 ${PASSWORD_MIN} 字符）：`);
  const confirm = await promptHidden("再输一次：");
  if (confirm !== password) {
    throw new AdminResetError("invalid_password", "两次输入不一致，未修改");
  }
  return password;
}

function lockLabel(row: AdminRow): string {
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    return `锁定至 ${row.lockedUntil.toISOString()}`;
  }
  return "-";
}

function printAdminTable(rows: AdminRow[]): void {
  if (rows.length === 0) {
    console.log("还没有管理员账号。首个管理员凭 STORE_ADMIN_SETUP_TOKEN 在 /setup 注册。");
    return;
  }
  const header = ["用户名", "状态", "须改密", "锁定", "最近登录"];
  const body = rows.map((row) => [
    row.username,
    row.status,
    row.mustChangePassword ? "是" : "否",
    lockLabel(row),
    row.lastLoginAt ? row.lastLoginAt.toISOString() : "-",
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((line) => line[index]!.length)),
  );
  const render = (line: string[]) =>
    line.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  console.log(render(header));
  for (const line of body) console.log(render(line));
}

async function main(): Promise<number> {
  const { args, error } = parseResetArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    console.error("");
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  loadLocalEnv();
  if (!process.env.DATABASE_URL) {
    console.error(
      "需要 DATABASE_URL（未在环境或 .env.local 中找到）。本仓库约定：cd service && bun run admin:reset-password -- <username>",
    );
    return 1;
  }

  const db = getDb();
  try {
    if (args.list) {
      const rows = await listAdminRows(db);
      if (args.json) {
        console.log(JSON.stringify({ ok: true, admins: rows }, null, 2));
      } else {
        printAdminTable(rows);
      }
      return 0;
    }

    if (!args.username) {
      console.error("缺少用户名。");
      console.error("");
      console.error(USAGE);
      return 1;
    }

    const existing = await findAdminByUsername(db, args.username);
    if (!existing) {
      throw new AdminResetError("not_found", `找不到管理员 "${args.username}"`);
    }

    const password = await resolvePassword(args);
    const result = await resetAdminPassword(db, {
      username: existing.username,
      password,
      keepSessions: args.keepSessions,
    });

    const warnings: string[] = [];
    if (result.status !== "active") {
      warnings.push("该账号状态是 disabled，密码已换但仍然登不进去：先启用账号。");
    }
    if (args.keepSessions && result.sessionsKept > 0) {
      warnings.push(`保留了 ${result.sessionsKept} 个会话（--keep-sessions），旧口令的会话仍在。`);
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            admin: {
              id: result.id,
              username: result.username,
              status: result.status,
            },
            password: args.source === "generated" ? password : undefined,
            sessionsEnded: result.sessionsEnded,
            sessionsKept: result.sessionsKept,
            audit: "admin.password.reset_cli",
            warnings,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const summary = [
      `已重置 ${result.username} 的密码。`,
      `  会话：${result.sessionsEnded > 0 ? `已结束 ${result.sessionsEnded} 个` : "无会话需要结束"}`,
      "  锁定与失败次数：已清零（must_change_password 也清掉了）",
      `  审计：admin.password.reset_cli`,
      ...warnings.map((line) => `  注意：${line}`),
    ].join("\n");

    if (args.source === "generated") {
      // stdout carries only the password so `PW=$(bun run ... --generate)` stays clean.
      console.error(summary);
      console.log(password);
    } else {
      console.log(summary);
    }
    return 0;
  } finally {
    await closeDb();
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof AdminResetError) {
      console.error(error.message);
      process.exit(error.code === "not_found" ? 2 : error.code === "invalid_password" ? 3 : 1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

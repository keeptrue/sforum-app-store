/**
 * Domain logic behind the `admin:reset-password` shell command.
 *
 * The console has no email facility, so a lost administrator password is recovered from the
 * server shell. Two entrypoints exist on purpose:
 *
 * - `scripts/admin-password.ts` — the original interactive one (`admin:password`).
 * - `scripts/admin-reset-password.ts` — this one: scriptable. It can take the password from a
 *   pipe, mint a random one, or list accounts, which is what a container restart, a recovery
 *   runbook, or an operator without a TTY actually needs.
 *
 * Everything here is transport-free so the argument parser, the env parser and the database
 * transition can be tested without spawning a process.
 */
import { randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { adminAccounts, adminSessions } from "@/db/schema";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/admin/password";
import { recordAudit } from "@/lib/moderation/events";

export type PasswordSource = "interactive" | "stdin" | "generated";

export interface ResetArgs {
  help: boolean;
  list: boolean;
  json: boolean;
  keepSessions: boolean;
  source: PasswordSource;
  username: string | null;
}

export interface ParsedArgs {
  args: ResetArgs;
  error: string | null;
}

export const USAGE = `重置商城本地管理员密码（无邮件找回，只能在服务器上做）

用法：
  bun run admin:reset-password -- <username>                  交互式，隐藏输入并二次确认
  bun run admin:reset-password -- <username> --generate       生成 24 字符随机密码，只打印一次
  bun run admin:reset-password -- <username> --password-stdin 从标准输入读一行新密码
  bun run admin:reset-password -- --list                      列出管理员账号

选项：
  --keep-sessions   保留该账号现有会话（默认全部结束：旧口令可能已在别人手里）
  --json            输出机器可读 JSON（含 --generate 生成的密码）
  -h, --help        显示本帮助

退出码：0 成功 / 1 参数或环境错误 / 2 账号不存在 / 3 新密码不合格
`;

export function parseResetArgs(argv: string[]): ParsedArgs {
  const args: ResetArgs = {
    help: false,
    list: false,
    json: false,
    keepSessions: false,
    source: "interactive",
    username: null,
  };
  let error: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--keep-sessions":
        args.keepSessions = true;
        break;
      case "--generate":
        if (args.source === "stdin") {
          error ??= "--generate 与 --password-stdin 只能选一个";
        }
        args.source = "generated";
        break;
      case "--password-stdin":
        if (args.source === "generated") {
          error ??= "--generate 与 --password-stdin 只能选一个";
        }
        args.source = "stdin";
        break;
      case "--user": {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          error ??= "--user 需要一个用户名";
          break;
        }
        index += 1;
        if (args.username) error ??= "只能指定一个用户名";
        args.username = value.trim();
        break;
      }
      default:
        if (arg.startsWith("-")) {
          error ??= `未知选项 ${arg}`;
          break;
        }
        if (args.username) {
          error ??= "只能指定一个用户名";
          break;
        }
        args.username = arg.trim();
        break;
    }
  }

  if (args.list && args.username) {
    error ??= "--list 不接受用户名";
  }

  return { args, error };
}

/** Minimal `.env` reader: no expansion, no multiline values — enough for a recovery shell. */
export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = body.indexOf("=");
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "-_";
const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

/**
 * 24 characters from a 60-symbol alphabet ≈ 141 bits, with one guaranteed member of each
 * class so the result cannot be rejected by a future policy that wants mixed classes.
 * `randomInt` avoids the modulo bias of `byte % length`.
 */
export function generatePassword(length = 24): string {
  if (length < 4) throw new Error("length must be at least 4");
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALPHABET));
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const current = chars[index]!;
    chars[index] = chars[swap]!;
    chars[swap] = current;
  }
  return chars.join("");
}

export class AdminResetError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_password" | "verify_failed",
    message: string,
  ) {
    super(message);
    this.name = "AdminResetError";
  }
}

export interface AdminRow {
  id: string;
  username: string;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const ADMIN_COLUMNS = {
  id: adminAccounts.id,
  username: adminAccounts.username,
  status: adminAccounts.status,
  mustChangePassword: adminAccounts.mustChangePassword,
  lockedUntil: adminAccounts.lockedUntil,
  lastLoginAt: adminAccounts.lastLoginAt,
  createdAt: adminAccounts.createdAt,
};

export async function listAdminRows(db: Db): Promise<AdminRow[]> {
  return db.select(ADMIN_COLUMNS).from(adminAccounts).orderBy(adminAccounts.createdAt);
}

export async function findAdminByUsername(db: Db, username: string): Promise<AdminRow | null> {
  const [row] = await db
    .select(ADMIN_COLUMNS)
    .from(adminAccounts)
    // Same case-insensitive lookup as login: the unique index is on `lower(username)`.
    .where(sql`lower(${adminAccounts.username}) = lower(${username})`)
    .limit(1);
  return row ?? null;
}

export interface ResetInput {
  username: string;
  password: string;
  keepSessions?: boolean;
}

export interface ResetResult {
  id: string;
  username: string;
  status: "active" | "disabled";
  sessionsEnded: number;
  sessionsKept: number;
}

/**
 * Overwrites the password hash, clears the lockout, ends sessions, writes an audit row, then
 * re-reads the row and checks the new password against it. The read-back is the point: a reset
 * that silently stored an unverifiable hash would only be discovered by the operator who
 * cannot log in.
 */
export async function resetAdminPassword(db: Db, input: ResetInput): Promise<ResetResult> {
  const row = await findAdminByUsername(db, input.username);
  if (!row) {
    throw new AdminResetError("not_found", `找不到管理员 "${input.username}"`);
  }

  const problem = validatePassword(input.password, row.username);
  if (problem) {
    throw new AdminResetError("invalid_password", problem);
  }

  await db
    .update(adminAccounts)
    .set({
      passwordHash: hashPassword(input.password),
      mustChangePassword: false,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(adminAccounts.id, row.id));

  let sessionsEnded = 0;
  let sessionsKept = 0;
  if (input.keepSessions) {
    const kept = await db
      .select({ id: adminSessions.id })
      .from(adminSessions)
      .where(eq(adminSessions.adminId, row.id));
    sessionsKept = kept.length;
  } else {
    const deleted = await db
      .delete(adminSessions)
      .where(eq(adminSessions.adminId, row.id))
      .returning({ id: adminSessions.id });
    sessionsEnded = deleted.length;
  }

  await recordAudit(db, {
    action: "admin.password.reset_cli",
    targetType: "admin",
    targetId: row.id,
    details: {
      username: row.username,
      via: "cli",
      command: "admin:reset-password",
      sessionsEnded,
      sessionsKept,
    },
  });

  const [check] = await db
    .select({ passwordHash: adminAccounts.passwordHash })
    .from(adminAccounts)
    .where(eq(adminAccounts.id, row.id))
    .limit(1);
  if (!check || !verifyPassword(input.password, check.passwordHash)) {
    throw new AdminResetError("verify_failed", "写入后回读校验失败，密码未生效");
  }

  return {
    id: row.id,
    username: row.username,
    status: row.status,
    sessionsEnded,
    sessionsKept,
  };
}

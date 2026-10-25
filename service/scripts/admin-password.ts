/**
 * Reset a store-local administrator's password from the server shell.
 *
 * There is no email in this product, so this is the recovery path when nobody can sign in —
 * including the case where the only administrator is locked out. Run it on the box that holds
 * `DATABASE_URL`:
 *
 *   cd service && bun run admin:password -- <username>
 *
 * The new password is read with echo disabled and typed twice; it is never echoed, never
 * written to shell history and never logged. Every run writes an audit row with `via: "cli"`.
 */
import { eq, sql } from "drizzle-orm";

import { closeDb, getDb } from "@/db/client";
import { adminAccounts } from "@/db/schema";
import { hashPassword, validatePassword } from "@/lib/admin/password";
import { recordAudit } from "@/lib/moderation/events";

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
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
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          // Ctrl-C: leave the terminal usable before bailing out.
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

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("需要 DATABASE_URL。本仓库约定：cd service && bun run admin:password -- <username>");
    process.exit(1);
  }

  const username = process.argv.slice(2).find((arg) => !arg.startsWith("--"))?.trim();
  if (!username) {
    console.error("用法：bun run admin:password -- <username>");
    process.exit(1);
  }

  const db = getDb();
  const [row] = await db
    .select({ id: adminAccounts.id, username: adminAccounts.username })
    .from(adminAccounts)
    .where(sql`lower(${adminAccounts.username}) = lower(${username})`)
    .limit(1);

  if (!row) {
    console.error(`找不到管理员 "${username}"`);
    await closeDb();
    process.exit(1);
  }

  const password = await promptHidden(`新密码（至少 12 字符）：`);
  const problem = validatePassword(password, row.username);
  if (problem) {
    console.error(problem);
    await closeDb();
    process.exit(1);
  }

  const confirm = await promptHidden("再输一次：");
  if (confirm !== password) {
    console.error("两次输入不一致，未修改");
    await closeDb();
    process.exit(1);
  }

  await db
    .update(adminAccounts)
    .set({
      passwordHash: hashPassword(password),
      mustChangePassword: false,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(adminAccounts.id, row.id));

  // Sessions are dropped: the whole point of a shell reset is that the old credential may be
  // in someone else's hands.
  await db.execute(sql`delete from admin_sessions where admin_id = ${row.id}`);

  await recordAudit(db, {
    action: "admin.password.reset_cli",
    targetType: "admin",
    targetId: row.id,
    details: { username: row.username, via: "cli" },
  });

  console.log(`已重置 ${row.username} 的密码，并结束其全部会话。`);
  await closeDb();
}


await main();

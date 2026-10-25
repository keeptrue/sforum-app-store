"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ForumAccountRow } from "@/lib/admin/accounts";
import { jsonRequest, requestJson } from "@/lib/http-client";

type ConfirmKind = "grant" | "revoke" | "sessions";

const CONFIRM_COPY: Record<ConfirmKind, { verb: string; title: string; description: string }> = {
  grant: {
    verb: "授予",
    title: "授予审核员权限？",
    description: "对方将能进入审核台，批准、驳回或下架任何开发者的提交。",
  },
  revoke: {
    verb: "撤销",
    title: "撤销审核员权限？",
    description: "撤销后对方立即失去审核台入口；已登录的会话不受影响。",
  },
  sessions: {
    verb: "强制下线",
    title: "强制下线？",
    description: "该账号在所有设备上的商城会话会立即失效，需要重新登录。",
  },
};

/**
 * Forum identities and their one grantable role (`moderator`). The retired `admin` row is
 * shown as a warning rather than an action: it grants nothing since the 2026-10-25 change.
 */
export function ForumAccountsTable({
  initialRows,
  initialTotal,
}: {
  initialRows: ForumAccountRow[];
  initialTotal: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<{
    row: ForumAccountRow;
    kind: ConfirmKind;
  } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true);
    const result = await requestJson<{ accounts: ForumAccountRow[]; total: number }>(
      `/api/admin/forum-accounts?q=${encodeURIComponent(query.trim())}`,
    );
    setSearching(false);
    if (!result.ok) {
      toast.error(result.failure.message || "查询失败");
      return;
    }
    setRows(result.data.accounts);
    setTotal(result.data.total);
  }

  function openConfirm(row: ForumAccountRow, kind: ConfirmKind) {
    setConfirmTarget({ row, kind });
    setConfirmError(null);
    setConfirmPending(false);
  }

  function closeConfirm() {
    setConfirmTarget(null);
    setConfirmError(null);
    setConfirmPending(false);
  }

  async function runConfirm() {
    if (!confirmTarget || confirmPending) return;
    const { row, kind } = confirmTarget;
    const verb = CONFIRM_COPY[kind].verb;
    setConfirmPending(true);
    setConfirmError(null);

    if (kind === "sessions") {
      const result = await requestJson<{ revoked: number }>(
        `/api/admin/forum-accounts/${row.id}/sessions`,
        { method: "DELETE" },
      );
      setConfirmPending(false);
      if (!result.ok) {
        setConfirmError(result.failure.message || "操作失败");
        return;
      }
      setRows((current) =>
        current.map((item) => (item.id === row.id ? { ...item, sessionCount: 0 } : item)),
      );
      toast.success(`已结束 ${result.data.revoked} 个会话`);
    } else {
      const grant = kind === "grant";
      const result = grant
        ? await jsonRequest(`/api/admin/forum-accounts/${row.id}/roles`, "POST", {
            role: "moderator",
          })
        : await requestJson(`/api/admin/forum-accounts/${row.id}/roles`, { method: "DELETE" });
      setConfirmPending(false);
      if (!result.ok) {
        setConfirmError(result.failure.message || `${verb}失败`);
        return;
      }
      setRows((current) =>
        current.map((item) => (item.id === row.id ? { ...item, isModerator: grant } : item)),
      );
      toast.success(`已${verb}审核员权限`);
    }

    closeConfirm();
    router.refresh();
  }

  return (
    <>
      <form onSubmit={search} className="mb-3 flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按用户名、显示名、邮箱或 issuer 搜索"
          aria-label="搜索论坛账号"
          className="max-w-sm"
        />
        <Button type="submit" variant="outline" size="sm" disabled={searching}>
          {searching ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Search className="size-4" aria-hidden />
          )}
          搜索
        </Button>
        <span className="whitespace-nowrap text-xs text-muted-foreground">共 {total} 个</span>
      </form>

      <div className="overflow-x-auto surface">
        <table className="w-full text-sm">
          <caption className="sr-only">论坛账号</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">账号</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">来源</th>
              <th scope="col" className="px-3 py-2 font-medium">角色</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">会话</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  没有匹配的论坛账号
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{label(row)}</span>
                    {row.email ? (
                      <span className="ml-2 break-all text-xs text-muted-foreground">
                        {row.email}
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground lg:table-cell">
                    {row.issuerKey}#{row.sub}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.isModerator ? (
                      <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[12.5px]">
                        审核员
                      </span>
                    ) : (
                      <span className="text-[12.5px] text-muted-foreground">普通用户</span>
                    )}
                    {row.legacyAdmin ? (
                      <span
                        title="store_roles.role='admin' 已废弃，不再授予任何权限"
                        className="ml-1.5 hidden whitespace-nowrap rounded-full border border-dashed border-border px-2 py-0.5 text-[12.5px] text-muted-foreground md:inline-block"
                      >
                        旧 admin（不生效）
                      </span>
                    ) : null}
                  </td>
                  <td className="hidden px-3 py-2.5 tabular-nums md:table-cell">
                    {row.sessionCount}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openConfirm(row, row.isModerator ? "revoke" : "grant")}
                      >
                        {row.isModerator ? (
                          <ShieldOff className="size-3.5" aria-hidden />
                        ) : (
                          <ShieldCheck className="size-3.5" aria-hidden />
                        )}
                        {row.isModerator ? "撤销审核员" : "授予审核员"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={row.sessionCount === 0}
                        onClick={() => openConfirm(row, "sessions")}
                      >
                        <ShieldOff className="size-3.5" aria-hidden />
                        强制下线
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) closeConfirm();
        }}
        title={
          confirmTarget
            ? `${CONFIRM_COPY[confirmTarget.kind].title}「${label(confirmTarget.row)}」`
            : ""
        }
        description={confirmTarget ? CONFIRM_COPY[confirmTarget.kind].description : undefined}
        confirmLabel={confirmTarget ? CONFIRM_COPY[confirmTarget.kind].verb : undefined}
        tone={confirmTarget?.kind === "grant" ? "default" : "danger"}
        pending={confirmPending}
        error={confirmError}
        onConfirm={() => void runConfirm()}
      />
    </>
  );
}

function label(row: ForumAccountRow): string {
  return row.displayName?.trim() || row.username?.trim() || `${row.issuerKey}#${row.sub}`;
}

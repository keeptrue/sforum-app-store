"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlugZap, Plus } from "lucide-react";
import { toast } from "sonner";

import { IssuerDialog } from "@/components/admin/issuer-dialog";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IssuerRow } from "@/lib/admin/issuers";
import { jsonRequest, requestJson } from "@/lib/http-client";

function formatTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * The OAuth2 issuer list. Retiring is a soft delete — the row stays because forum accounts
 * reference `issuer_key`, it just cannot be used to log in any more.
 *
 * At most one row may be active, so "新增" is closed while one is: the button is disabled
 * here and the same rule is enforced in the domain layer and by a partial unique index.
 */
export function IssuersTable({
  issuers,
  callbackUrl,
  hasActive,
}: {
  issuers: IssuerRow[];
  callbackUrl: string;
  hasActive: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<IssuerRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<IssuerRow | null>(null);
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(row: IssuerRow) {
    setEditing(row);
    setDialogOpen(true);
  }

  async function verify(row: IssuerRow) {
    setBusyKey(row.issuerKey);
    const result = await jsonRequest<{ ok: boolean; message: string }>(
      `/api/admin/issuers/${encodeURIComponent(row.issuerKey)}/verify`,
      "POST",
    );
    setBusyKey(null);

    if (!result.ok) {
      toast.error(result.failure.message || "探测失败");
      return;
    }
    if (result.data.ok) {
      toast.success(`连接正常：${result.data.message}`);
    } else {
      toast.error(result.data.message);
    }
    router.refresh();
  }

  async function runStatusChange() {
    if (!statusTarget || statusPending) return;
    const row = statusTarget;
    const next = row.status === "active" ? "retired" : "active";
    const verb = next === "retired" ? "停用" : "启用";
    setStatusPending(true);
    setStatusError(null);

    const result = await jsonRequest(
      `/api/admin/issuers/${encodeURIComponent(row.issuerKey)}`,
      "PATCH",
      { status: next },
    );
    setStatusPending(false);

    if (!result.ok) {
      setStatusError(result.failure.message || `${verb}失败`);
      return;
    }
    toast.success(`已${verb}`);
    setStatusTarget(null);
    router.refresh();
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {hasActive
            ? "已有一个启用中的 issuer：要换论坛请先停用它。停用后前台登录会显示「还没有配置登录来源」，历史账号与商品保留。"
            : "没有启用的 issuer 时，论坛用户无法登录；前台会显示「还没有配置登录来源」。"}
        </p>
        <Button
          size="sm"
          onClick={openCreate}
          disabled={hasActive}
          title={
            hasActive
              ? "一个商城只接入一个论坛：先停用当前的 issuer 再新增"
              : undefined
          }
        >
          <Plus className="size-4" aria-hidden />
          新增 issuer
        </Button>
      </div>

      <div className="overflow-x-auto surface">
        <table className="w-full text-sm">
          <caption className="sr-only">OAuth2 issuer</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">issuer</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">论坛地址</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">client_id</th>
              <th scope="col" className="px-3 py-2 font-medium">状态</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">最近探测</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {issuers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  还没有配置任何 issuer
                </td>
              </tr>
            ) : (
              issuers.map((row) => (
                <tr key={row.issuerKey}>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{row.displayName}</span>
                    <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
                      {row.issuerKey}
                    </span>
                    <span className="ml-2 text-[12.5px] text-muted-foreground">
                      {row.accountCount} 个账号
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground lg:table-cell">
                    {row.baseUrl}
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[12.5px] lg:table-cell">
                    {row.clientId}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.status === "active" ? (
                      <Badge variant="success">登录来源</Badge>
                    ) : (
                      <Badge variant="muted">已停用</Badge>
                    )}
                  </td>
                  <td className="hidden px-3 py-2.5 text-[12.5px] md:table-cell">
                    {row.lastError ? (
                      <span className="text-destructive" title={row.lastError}>
                        失败
                      </span>
                    ) : (
                      <span className="font-mono text-muted-foreground">
                        {formatTime(row.lastVerifiedAt)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busyKey === row.issuerKey}
                        onClick={() => verify(row)}
                      >
                        {busyKey === row.issuerKey ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <PlugZap className="size-3.5" aria-hidden />
                        )}
                        测试连接
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openEdit(row)}
                      >
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busyKey === row.issuerKey}
                        onClick={() => {
                          setStatusTarget(row);
                          setStatusError(null);
                          setStatusPending(false);
                        }}
                      >
                        {row.status === "active" ? "停用" : "启用"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {dialogOpen ? (
        <IssuerDialog
          key={editing?.issuerKey ?? "new"}
          open={dialogOpen}
          issuer={editing}
          callbackUrl={callbackUrl}
          onOpenChange={(next) => {
            setDialogOpen(next);
            if (!next) setEditing(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={statusTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setStatusTarget(null);
            setStatusError(null);
            setStatusPending(false);
          }
        }}
        title={
          statusTarget?.status === "active"
            ? `停用「${statusTarget.displayName}」？`
            : `重新启用「${statusTarget?.displayName ?? ""}」？`
        }
        description={
          statusTarget?.status === "active"
            ? "停用后来自这个论坛的用户将无法登录开发者门户，前台会提示未配置登录来源。历史账号与商品归属保留。"
            : "一个商城只能有一个启用中的 issuer：已有别的启用项时会被拒绝。"
        }
        confirmLabel={statusTarget?.status === "active" ? "停用" : "启用"}
        tone={statusTarget?.status === "active" ? "danger" : "default"}
        pending={statusPending}
        error={statusError}
        onConfirm={() => void runStatusChange()}
      />
    </>
  );
}

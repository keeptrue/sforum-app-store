"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Power, PowerOff, ShieldOff } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field, FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";
import { SubmitButton } from "@/components/common/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminRow } from "@/lib/admin/accounts";
import { jsonRequest, requestJson } from "@/lib/http-client";

const PASSWORD_MIN = 12;

type ConfirmKind = "disable" | "enable" | "revoke";

const CONFIRM_COPY: Record<
  ConfirmKind,
  { verb: string; title: (name: string) => string; description: string }
> = {
  disable: {
    verb: "禁用",
    title: (name) => `禁用管理员「${name}」？`,
    description: "禁用后该账号无法再登录后台；已签发的会话保留到过期，可随时重新启用。",
  },
  enable: {
    verb: "启用",
    title: (name) => `启用管理员「${name}」？`,
    description: "启用后对方可以立即登录后台。",
  },
  revoke: {
    verb: "强制下线",
    title: (name) => `强制下线「${name}」？`,
    description: "该账号在所有设备上的会话会立即失效，对方需要重新登录。",
  },
};

function formatTime(value: Date | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Administrator rows with their three irreversible-ish actions. Every action confirms first:
 * these are the operations that lock people out, so they go through `ConfirmDialog` (in-dialog
 * pending + error) rather than a native `window.confirm` that hides the failure behind a toast.
 */
export function AdminAccountsTable({ admins }: { admins: AdminRow[] }) {
  const router = useRouter();
  const fieldId = useId();
  const formId = `${fieldId}-reset-form`;

  const [resetTarget, setResetTarget] = useState<AdminRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [confirmTarget, setConfirmTarget] = useState<{
    admin: AdminRow;
    kind: ConfirmKind;
  } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function openReset(admin: AdminRow) {
    setResetTarget(admin);
    setNewPassword("");
    setResetError(null);
    setResetPending(false);
  }

  function closeReset() {
    setResetTarget(null);
    setNewPassword("");
    setResetError(null);
    setResetPending(false);
  }

  function openConfirm(admin: AdminRow, kind: ConfirmKind) {
    setConfirmTarget({ admin, kind });
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
    const { admin, kind } = confirmTarget;
    setConfirmPending(true);
    setConfirmError(null);

    if (kind === "revoke") {
      const result = await requestJson<{ revoked: number }>(
        `/api/admin/accounts/${admin.id}/sessions`,
        { method: "DELETE" },
      );
      setConfirmPending(false);
      if (!result.ok) {
        setConfirmError(result.failure.message || "操作失败");
        return;
      }
      toast.success(`已结束 ${result.data.revoked} 个会话`);
    } else {
      const result = await jsonRequest(`/api/admin/accounts/${admin.id}`, "PATCH", {
        status: kind === "disable" ? "disabled" : "active",
      });
      setConfirmPending(false);
      if (!result.ok) {
        setConfirmError(result.failure.message || `${CONFIRM_COPY[kind].verb}失败`);
        return;
      }
      toast.success(`已${CONFIRM_COPY[kind].verb} ${admin.username}`);
    }

    closeConfirm();
    router.refresh();
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    if (!resetTarget || resetPending) return;
    if (newPassword.length < PASSWORD_MIN) {
      setResetError(`新密码至少 ${PASSWORD_MIN} 个字符。`);
      return;
    }

    setResetPending(true);
    setResetError(null);
    const result = await jsonRequest(
      `/api/admin/accounts/${resetTarget.id}/password`,
      "POST",
      { newPassword },
    );
    setResetPending(false);

    if (!result.ok) {
      setResetError(result.failure.message || "重置失败");
      return;
    }
    toast.success(`已重置 ${resetTarget.username} 的密码，对方下次登录须修改`);
    closeReset();
    router.refresh();
  }

  return (
    <>
      <div className="overflow-x-auto surface">
        <table className="w-full text-sm">
          <caption className="sr-only">管理员账号</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">账号</th>
              <th scope="col" className="px-3 py-2 font-medium">状态</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">最近登录</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">会话</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {admins.map((admin) => (
              <tr key={admin.id} className="align-middle">
                <td className="px-3 py-2.5">
                  <span className="font-medium">{admin.username}</span>
                  {admin.displayName && admin.displayName !== admin.username ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {admin.displayName}
                    </span>
                  ) : null}
                  {admin.mustChangePassword ? (
                    <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[12px] text-muted-foreground">
                      待改密
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  {admin.status === "active" ? (
                    <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[12.5px]">
                      启用
                    </span>
                  ) : (
                    <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[12.5px] text-muted-foreground">
                      已禁用
                    </span>
                  )}
                  {admin.lockedUntil && new Date(admin.lockedUntil) > new Date() ? (
                    <span className="ml-1.5 text-[12.5px] text-muted-foreground">已锁定</span>
                  ) : null}
                </td>
                <td className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground md:table-cell">
                  {formatTime(admin.lastLoginAt)}
                </td>
                <td className="hidden px-3 py-2.5 tabular-nums md:table-cell">
                  {admin.sessionCount}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => openReset(admin)}
                    >
                      <KeyRound className="size-3.5" aria-hidden />
                      重置密码
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={admin.sessionCount === 0}
                      onClick={() => openConfirm(admin, "revoke")}
                    >
                      <ShieldOff className="size-3.5" aria-hidden />
                      强制下线
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() =>
                        openConfirm(admin, admin.status === "active" ? "disable" : "enable")
                      }
                    >
                      {admin.status === "active" ? (
                        <PowerOff className="size-3.5" aria-hidden />
                      ) : (
                        <Power className="size-3.5" aria-hidden />
                      )}
                      {admin.status === "active" ? "禁用" : "启用"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={resetTarget !== null}
        onOpenChange={(next) => {
          if (!next) closeReset();
        }}
        title="重置密码"
        description={
          <>
            为「{resetTarget?.username ?? ""}」设置新密码。对方的所有会话会立即失效，
            下次登录必须先改密码。
          </>
        }
        size="md"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={closeReset} disabled={resetPending}>
              取消
            </Button>
            <SubmitButton form={formId} pending={resetPending} pendingLabel="重置中…">
              重置
            </SubmitButton>
          </>
        }
      >
        <form id={formId} onSubmit={submitReset} className="space-y-3" noValidate>
          <Field
            label="新密码"
            htmlFor={`${fieldId}-password`}
            required
            hint={`至少 ${PASSWORD_MIN} 个字符。`}
          >
            <Input
              id={`${fieldId}-password`}
              type="password"
              autoComplete="new-password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          {resetError ? <FormError>{resetError}</FormError> : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) closeConfirm();
        }}
        title={
          confirmTarget
            ? CONFIRM_COPY[confirmTarget.kind].title(confirmTarget.admin.username)
            : ""
        }
        description={confirmTarget ? CONFIRM_COPY[confirmTarget.kind].description : undefined}
        confirmLabel={confirmTarget ? CONFIRM_COPY[confirmTarget.kind].verb : undefined}
        tone={confirmTarget?.kind === "enable" ? "default" : "danger"}
        pending={confirmPending}
        error={confirmError}
        onConfirm={() => void runConfirm()}
      />
    </>
  );
}

"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";
import { SubmitButton } from "@/components/common/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jsonRequest } from "@/lib/http-client";

const PASSWORD_MIN = 12;

/**
 * Creates an administrator. The password entered here is an *initial* one: the server marks
 * the account `must_change_password`, so it cannot survive the first login.
 */
export function CreateAdminDialog() {
  const router = useRouter();
  const fieldId = useId();
  const formId = `${fieldId}-form`;
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = (name: string) => `${fieldId}-${name}`;

  function reset() {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setError(null);
    setPending(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (password.length < PASSWORD_MIN) {
      setError(`初始密码至少 ${PASSWORD_MIN} 个字符。`);
      return;
    }

    setPending(true);
    const result = await jsonRequest<{ username: string }>(
      "/api/admin/accounts",
      "POST",
      {
        username: username.trim(),
        displayName: displayName.trim(),
        password,
      },
    );

    if (!result.ok) {
      setPending(false);
      setError(result.failure.message || "创建失败，请重试。");
      return;
    }

    toast.success(`管理员 ${result.data.username} 已创建，首次登录须改密码`);
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
      trigger={
        <Button size="sm">
          <Plus className="size-4" aria-hidden />
          新建管理员
        </Button>
      }
      title="新建管理员"
      description="对方用这个初始密码登录后必须先改密码，才能进入后台。"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            取消
          </Button>
          <SubmitButton
            form={formId}
            pending={pending}
            pendingLabel="创建中…"
          >
            创建
          </SubmitButton>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3" noValidate>
        <Field label="用户名" htmlFor={id("username")} required>
          <Input
            id={id("username")}
            autoComplete="off"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="显示名（可选）" htmlFor={id("display")}>
          <Input
            id={id("display")}
            autoComplete="off"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field
          label="初始密码"
          htmlFor={id("password")}
          required
          hint={`至少 ${PASSWORD_MIN} 个字符。`}
        >
          <Input
            id={id("password")}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Modal>
  );
}

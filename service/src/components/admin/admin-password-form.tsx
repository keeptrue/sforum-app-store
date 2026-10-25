"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jsonRequest } from "@/lib/http-client";
import { useHydrated, useHydrationStalled } from "@/lib/use-hydrated";

const PASSWORD_MIN = 12;

/**
 * Forced password change. Reached when an administrator was created by someone else
 * (`must_change_password`), and reachable on demand from the account menu.
 *
 * Submitting is gated on hydration: three password fields in a native GET fallback would
 * land in the URL.
 */
export function AdminPasswordForm({ base }: { base: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const stalled = useHydrationStalled(hydrated);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (next.length < PASSWORD_MIN) {
      setError(`新密码至少 ${PASSWORD_MIN} 个字符。`);
      return;
    }
    if (next !== confirm) {
      setError("两次输入的新密码不一致。");
      return;
    }

    setPending(true);
    const result = await jsonRequest<{ ok: true }>("/api/admin/password", "POST", {
      currentPassword: current,
      newPassword: next,
    });

    if (!result.ok) {
      setPending(false);
      setError(result.failure.message || "修改失败，请重试。");
      return;
    }

    // The server drops every session of this admin, including this one.
    toast.success("密码已更新，请用新密码重新登录");
    router.replace(`${base}/login`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <label htmlFor="pw-current" className="text-sm font-medium">
          当前密码
        </label>
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pw-next" className="text-sm font-medium">
          新密码
        </label>
        <Input
          id="pw-next"
          type="password"
          autoComplete="new-password"
          required
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">至少 {PASSWORD_MIN} 个字符。</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="pw-confirm" className="text-sm font-medium">
          确认新密码
        </label>
        <Input
          id="pw-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={!hydrated || pending}>
        {!hydrated || pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        {!hydrated ? "正在加载…" : pending ? "更新中…" : "更新密码"}
      </Button>

      {stalled ? (
        <p className="text-xs text-muted-foreground">
          客户端脚本没有加载完，这个按钮不会提交。请强制刷新（Ctrl/Cmd+Shift+R）重试；
          若反复出现，检查 <code className="font-mono">/_next/static</code> 是否被代理或缓存拦掉。
        </p>
      ) : null}
    </form>
  );
}

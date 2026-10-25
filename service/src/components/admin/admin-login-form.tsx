"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { jsonRequest } from "@/lib/http-client";
import { useHydrated, useHydrationStalled } from "@/lib/use-hydrated";

/**
 * Password login for a store-local administrator.
 *
 * The error is rendered next to the form and stays there (AGENTS.md: blocking errors live
 * beside the control, toasts are for success). The username field is not pre-filled from any
 * prior state — there is no "remember who you were" on a shared operations machine.
 *
 * Submitting is gated on hydration: before React attaches `onSubmit` a click would fall back
 * to a native GET and put the password in the URL.
 */
export function AdminLoginForm({ base }: { base: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const stalled = useHydrationStalled(hydrated);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const result = await jsonRequest<{ mustChangePassword: boolean } | null>(
      "/api/admin/session",
      "POST",
      { username: username.trim(), password },
    );

    if (!result.ok) {
      setPending(false);
      setError(result.failure.message || "登录失败，请重试。");
      return;
    }

    // A 200 whose body is not the JSON this route always sends (a proxy interstitial, an HTML
    // challenge page, a truncated response) arrives as `data: null`. Without this guard the
    // property read throws, `pending` is never cleared, and the button spins forever.
    if (!result.data) {
      setPending(false);
      setError("服务器返回了无法识别的响应，请重试。");
      return;
    }

    toast.success("已登录");
    router.replace(result.data.mustChangePassword ? `${base}/password` : base);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <label htmlFor="admin-username" className="text-sm font-medium">
          用户名
        </label>
        <Input
          id="admin-username"
          name="username"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="admin-password" className="text-sm font-medium">
          密码
        </label>
        <Input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
        {!hydrated ? "正在加载…" : pending ? "登录中…" : "登录"}
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

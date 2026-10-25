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
 * First-administrator registration.
 *
 * Requires the one-shot `STORE_ADMIN_SETUP_TOKEN`; without it the server refuses outright.
 * The form re-checks the length only to fail fast — the server is the authority.
 *
 * Submitting is gated on hydration: this form carries a password and a setup token, and a
 * native GET fallback would put both in the URL.
 */
export function AdminSetupForm({ base }: { base: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const stalled = useHydrationStalled(hydrated);
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (password.length < PASSWORD_MIN) {
      setError(`密码至少 ${PASSWORD_MIN} 个字符。`);
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }

    setPending(true);
    const result = await jsonRequest<{ username: string } | null>(
      "/api/admin/setup",
      "POST",
      {
        token,
        username: username.trim(),
        password,
      },
    );

    if (!result.ok) {
      setPending(false);
      setError(result.failure.message || "注册失败，请重试。");
      return;
    }

    // Same trap as the login form: a 200 without the expected JSON body would throw here and
    // leave the button spinning with no way back.
    if (!result.data) {
      setPending(false);
      setError("服务器返回了无法识别的响应，请重试。");
      return;
    }

    toast.success(`管理员 ${result.data.username} 已创建`);
    router.replace(base);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <label htmlFor="setup-token" className="text-sm font-medium">
          Setup token
        </label>
        <Input
          id="setup-token"
          name="token"
          autoComplete="off"
          spellCheck={false}
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          部署时写入的 <code className="font-mono text-[12.5px]">STORE_ADMIN_SETUP_TOKEN</code>。
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="setup-username" className="text-sm font-medium">
          用户名
        </label>
        <Input
          id="setup-username"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="setup-password" className="text-sm font-medium">
          密码
        </label>
        <Input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">至少 {PASSWORD_MIN} 个字符。</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="setup-confirm" className="text-sm font-medium">
          确认密码
        </label>
        <Input
          id="setup-confirm"
          name="confirm"
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
        {!hydrated ? "正在加载…" : pending ? "创建中…" : "创建管理员"}
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

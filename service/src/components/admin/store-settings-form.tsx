"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field, FormError } from "@/components/common/field";
import { Section } from "@/components/common/section";
import { SubmitButton } from "@/components/common/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { jsonRequest } from "@/lib/http-client";
import type { RateLimitRowView, StoreSettingsView } from "@/lib/settings/service";

/**
 * 系统设置: the keys an operator changes without a redeploy.
 *
 * Two things this form refuses to hide:
 * - **where each value comes from** (database / env seed / built-in). "Saved but not in
 *   effect" is the failure this page exists to prevent, so every row says which layer answered.
 * - **the blast radius of the public URL**: the OAuth callback, webhook and Setup URL it
 *   derives are printed right under the input, and a host mismatch against the address the
 *   console is being served on is called out — that mismatch is the classic "login does
 *   nothing".
 *
 * Confirmation is server-driven on purpose: the API answers 409 with the concrete consequence
 * (`confirm_origin_change` / `confirm_insecure_transition`) and the dialog quotes it, so the
 * warning cannot drift from the rule that enforces it.
 */

const CHANNEL_LABELS: Record<string, string> = {
  login: "论坛登录（按 IP）",
  "admin-login": "后台密码登录（按 IP）",
  submit: "开发者提交（按账号）",
  "download-ip": "下载（按 IP）",
  "download-token": "下载（按 token）",
  repo: "连接仓库（按账号）",
};

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function sourceBadge(source: StoreSettingsView["publicUrlSource"]) {
  return source === "database" ? (
    <Badge variant="success">后台设置</Badge>
  ) : (
    <Badge variant="muted">STORE_PUBLIC_URL 种子</Badge>
  );
}

function modeLabel(mode: "proxy" | "redirect"): string {
  return mode === "redirect" ? "302 直链" : "商城转发";
}

function CopyValue({
  id,
  value,
  label,
}: {
  id?: string;
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("当前环境无法访问剪贴板，请手动选取");
    }
  }

  return (
    <div className="flex items-stretch gap-1.5">
      <Input
        id={id}
        value={value}
        readOnly
        spellCheck={false}
        className="font-mono text-[12.5px]"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={copy}
        aria-label={label}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

type PutOutcome =
  | { kind: "saved" }
  | { kind: "confirm"; confirm: { kind: "origin" | "insecure"; message: string } }
  | { kind: "error"; message: string };

function rateLimitSource(source: RateLimitRowView["source"]) {
  if (source === "database") return <Badge variant="success">后台设置</Badge>;
  if (source === "env") return <Badge variant="outline">环境变量</Badge>;
  return <Badge variant="muted">内置默认</Badge>;
}

export function StoreSettingsForm({ view }: { view: StoreSettingsView }) {
  const router = useRouter();
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const [publicUrl, setPublicUrl] = useState(view.publicUrl);
  const [ttlMinutes, setTtlMinutes] = useState(
    String(Math.round(view.downloadTtlSeconds / 60)),
  );
  // "" means "follow STORE_DOWNLOAD_MODE"; the API takes null for that.
  const [downloadMode, setDownloadMode] = useState<string>(
    view.downloadModeOverride ?? "",
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(view.rateLimits.map((row) => [row.channel, row.override ?? ""])),
  );

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "origin" | "insecure";
    message: string;
  } | null>(null);
  /**
   * Confirmations already given in this attempt. A single save can need both (new host *and*
   * a new scheme), and the second 409 must not throw the first answer away.
   */
  const [accepted, setAccepted] = useState({ origin: false, insecure: false });
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const effectiveHost = hostOf(view.publicUrl);
  const hostMismatch =
    Boolean(view.requestHost) && Boolean(effectiveHost) && view.requestHost !== effectiveHost;

  /** Re-seed the local state from what the server says is in effect now. */
  function adopt(next: StoreSettingsView) {
    setPublicUrl(next.publicUrl);
    setTtlMinutes(String(Math.round(next.downloadTtlSeconds / 60)));
    setDownloadMode(next.downloadModeOverride ?? "");
    setLimits(
      Object.fromEntries(next.rateLimits.map((row) => [row.channel, row.override ?? ""])),
    );
  }

  async function put(extra: {
    confirmOriginChange?: boolean;
    confirmInsecureTransition?: boolean;
  } = {}): Promise<PutOutcome> {
    setSaving(true);
    setFormError(null);

    const result = await jsonRequest<{
      ok: true;
      changed: boolean;
      settings: StoreSettingsView;
    }>("/api/admin/settings", "PUT", {
      publicUrl: publicUrl.trim(),
      // Empty means "use the built-in 30 minutes"; the field is minutes, the API wants seconds.
      downloadTtlSeconds: ttlMinutes.trim() ? Number(ttlMinutes) * 60 : null,
      // Empty means "follow STORE_DOWNLOAD_MODE".
      downloadMode: downloadMode || null,
      rateLimits: limits,
      confirmOriginChange: extra.confirmOriginChange ?? accepted.origin,
      confirmInsecureTransition: extra.confirmInsecureTransition ?? accepted.insecure,
    });
    setSaving(false);

    if (!result.ok) {
      const failure = result.failure;
      if (failure.code === "confirm_origin_change") {
        return { kind: "confirm", confirm: { kind: "origin", message: failure.message } };
      }
      if (failure.code === "confirm_insecure_transition") {
        return { kind: "confirm", confirm: { kind: "insecure", message: failure.message } };
      }
      return { kind: "error", message: failure.message || "保存失败" };
    }

    adopt(result.data.settings);
    setConfirm(null);
    setAccepted({ origin: false, insecure: false });
    toast.success(result.data.changed ? "已保存，当前进程已生效" : "与现有值一致，没有改动");
    router.refresh();
    return { kind: "saved" };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const outcome = await put({});
    if (outcome.kind === "confirm") setConfirm(outcome.confirm);
    else if (outcome.kind === "error") setFormError(outcome.message);
  }

  async function confirmAndRetry() {
    if (!confirm || confirming) return;
    const kind = confirm.kind;
    const next = {
      origin: accepted.origin || kind === "origin",
      insecure: accepted.insecure || kind === "insecure",
    };
    setAccepted(next);
    setConfirming(true);
    setConfirmError(null);

    const outcome = await put({
      confirmOriginChange: next.origin,
      confirmInsecureTransition: next.insecure,
    });
    setConfirming(false);

    // A second gate (or a rejection) keeps the dialog family open with the reason in view.
    if (outcome.kind === "confirm") setConfirm(outcome.confirm);
    else if (outcome.kind === "error") setConfirmError(outcome.message);
  }

  async function reset() {
    if (resetting) return;
    setResetting(true);
    setResetError(null);

    const result = await jsonRequest<{ ok: true; settings: StoreSettingsView }>(
      "/api/admin/settings",
      "DELETE",
    );
    setResetting(false);

    if (!result.ok) {
      setResetError(result.failure.message || "恢复默认失败");
      return;
    }

    adopt(result.data.settings);
    setResetOpen(false);
    toast.success("已恢复默认：对外地址与下载分发回到环境变量，其余回到内置默认");
    router.refresh();
  }

  return (
    <div className="space-y-7">
      {hostMismatch ? (
        <div
          role="alert"
          className="rounded-control border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed"
        >
          <p className="text-sm font-medium">
            生效地址与当前访问地址不一致
          </p>
          <p className="mt-1">
            服务认为自己对外是 <span className="font-mono">{effectiveHost}</span>，但你正通过{" "}
            <span className="font-mono">{view.requestHost}</span> 访问后台。所有 OAuth 回调、
            下载短链与同源校验都按生效地址走——这正是「登录点了没反应」的典型症状。确认哪个是
            对外地址后改一处即可（改这里，或改 DNS/反代）。
          </p>
        </div>
      ) : null}

      {view.warnings.length > 0 ? (
        <div
          role="alert"
          className="rounded-control border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed"
        >
          {view.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-7">
        <Section
          id="public-url"
          title="对外地址"
          hint="每一个浏览器可见的绝对 URL 都从它派生：OAuth 回调、错误跳转、下载短链、GitHub webhook。"
        >
          <div className="surface space-y-4 px-4 py-4">
            <Field
              label="公开基址"
              htmlFor={id("public-url")}
              required
              hint={
                view.publicUrlSource === "database"
                  ? `当前生效：${view.publicUrl}（数据库覆盖了 STORE_PUBLIC_URL 种子 ${view.seedPublicUrl}）`
                  : `当前生效：${view.publicUrl}（来自环境变量 STORE_PUBLIC_URL；保存后以数据库为准）`
              }
            >
              {/* The badge drops under the input on a phone instead of squeezing the value. */}
              <div className="flex flex-wrap items-stretch gap-1.5">
                <Input
                  id={id("public-url")}
                  value={publicUrl}
                  onChange={(event) => setPublicUrl(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 basis-[16rem] font-mono text-[12.5px]"
                  placeholder="https://store.example.com"
                />
                <div className="flex shrink-0 items-center">
                  {sourceBadge(view.publicUrlSource)}
                </div>
              </div>
            </Field>

            <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
              <Field
                label="OAuth 回调地址"
                htmlFor={id("callback")}
                hint="论坛后台登记的 redirect URI 必须逐字一致，改地址后两边同时改。"
              >
                <CopyValue
                  id={id("callback")}
                  value={view.derived.callbackUrl}
                  label="复制 OAuth 回调地址"
                />
              </Field>
              <Field
                label="GitHub webhook"
                htmlFor={id("webhook")}
                hint="GitHub App 的 Webhook URL；改地址后到 GitHub 侧同步。"
              >
                <CopyValue
                  id={id("webhook")}
                  value={view.derived.webhookUrl}
                  label="复制 webhook 地址"
                />
              </Field>
            </div>

            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              会话 cookie 名由地址协议决定：现在是{" "}
              <span className="font-mono">{view.sessionCookieName}</span>
              {view.cookieSecure ? "（https：Secure + __Host- 前缀）" : "（http：无 Secure 前缀）"}。
              在 http 与 https 之间切换会让现有会话全部失效，所有人（含管理员）需要重新登录。
            </p>
          </div>
        </Section>

        <Section
          id="download-ttl"
          title="下载链接有效期"
          hint="签名短链是一次性凭证：过期后需要重新签发，正在下载的请求不受影响。"
        >
          <div className="surface space-y-3 px-4 py-4">
            <Field
              label="有效期（分钟）"
              htmlFor={id("ttl")}
              hint={`当前生效：${Math.round(view.downloadTtlSeconds / 60)} 分钟（${
                view.downloadTtlSource === "database" ? "后台设置" : "内置默认 30 分钟"
              }）。留空即回到默认。范围 5 分钟到 24 小时。`}
            >
              <Input
                id={id("ttl")}
                value={ttlMinutes}
                onChange={(event) => setTtlMinutes(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                className="max-w-[10rem] font-mono text-[12.5px]"
                placeholder="30"
              />
            </Field>
          </div>
        </Section>

        <Section
          id="download-mode"
          title="下载分发"
          hint="决定 /api/v1/download/{token} 是商城自己转发字节，还是把 GitHub 已经签好的地址交给客户端。"
        >
          <div className="surface space-y-3 px-4 py-4">
            <Field
              label="分发形态"
              htmlFor={id("download-mode")}
              hint={
                view.downloadModeSource === "database"
                  ? `当前生效：${modeLabel(view.downloadMode)}（后台设置；环境种子 ${modeLabel(view.seedDownloadMode)}）`
                  : `当前生效：${modeLabel(view.downloadMode)}（跟随 STORE_DOWNLOAD_MODE 种子）`
              }
            >
              <div className="flex max-w-[22rem] items-stretch gap-1.5">
                <Select
                  id={id("download-mode")}
                  value={downloadMode}
                  onChange={(event) => setDownloadMode(event.target.value)}
                  className="font-mono text-[12.5px]"
                >
                  <option value="">跟随环境变量（{modeLabel(view.seedDownloadMode)}）</option>
                  <option value="proxy">商城转发（proxy）</option>
                  <option value="redirect">302 直链（redirect）</option>
                </Select>
                <div className="flex shrink-0 items-center">
                  {view.downloadModeSource === "database" ? (
                    <Badge variant="success">后台设置</Badge>
                  ) : (
                    <Badge variant="muted">环境变量种子</Badge>
                  )}
                </div>
              </div>
            </Field>

            <ul className="space-y-1.5 border-t border-border pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">商城转发</span>
                ：带宽走这台机器；yank 之后旧链接下一次请求就 410；每一次下载都经过本服务的限流与日志。
              </li>
              <li>
                <span className="font-medium text-foreground">302 直链</span>
                ：字节从 GitHub 直接到用户，本机带宽≈0。
                <span className="font-medium text-foreground">已经发出的跳转撤不回来</span>
                ——yank 之后它们仍能用，直到上游签名到期（实测 1 小时）。
              </li>
              <li>私有仓库永远走商城转发：那个地址里带着仓库名、tag 与文件名。</li>
              <li>切换后先用一个真实论坛点一次安装：宿主是否跟随跨域 302 尚未验证，不跟随就回到商城转发。</li>
            </ul>
          </div>
        </Section>

        <Section
          id="rate-limits"
          title="限流"
          hint='格式 "<次数>/<秒>"，例如 10/300 表示每 5 分钟 10 次。留空即继承环境变量或内置默认。'
        >
          <div className="surface divide-y divide-border">
            {view.rateLimits.map((row) => (
              <div key={row.channel} className="px-4 py-3">
                <Field
                  label={CHANNEL_LABELS[row.channel] ?? row.channel}
                  htmlFor={id(`limit-${row.channel}`)}
                  hint={
                    row.invalidReason
                      ? `保存值无效，已回退：${row.invalidReason}`
                      : `当前生效：${row.effective}`
                  }
                >
                  <div className="flex items-center gap-2">
                    <Input
                      id={id(`limit-${row.channel}`)}
                      value={limits[row.channel] ?? ""}
                      onChange={(event) =>
                        setLimits((current) => ({
                          ...current,
                          [row.channel]: event.target.value,
                        }))
                      }
                      spellCheck={false}
                      autoComplete="off"
                      className="max-w-[10rem] font-mono text-[12.5px]"
                      placeholder={row.effective}
                    />
                    {rateLimitSource(row.source)}
                    <span className="font-mono text-[12.5px] text-muted-foreground">
                      {row.channel}
                    </span>
                  </div>
                </Field>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
            后台密码登录的限流不允许低于 3 次/窗口：再低就会把自己锁在后台外面。
          </p>
        </Section>

        {formError ? <FormError>{formError}</FormError> : null}

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={saving}>保存并立即生效</SubmitButton>
          <Button
            type="button"
            variant="outline"
            onClick={() => setResetOpen(true)}
            disabled={saving}
          >
            <RotateCcw aria-hidden />
            恢复默认
          </Button>
          <p className="text-[12.5px] text-muted-foreground">
            {view.updatedAt
              ? `上次修改：${view.updatedAt.slice(0, 16).replace("T", " ")} UTC${
                  view.updatedBy ? ` · ${view.updatedBy.displayName || view.updatedBy.username}` : ""
                }`
              : "还没有在后台改过任何设置"}
          </p>
        </div>
      </form>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setConfirmError(null);
            // Dismissing the dialog withdraws everything confirmed in this attempt.
            setAccepted({ origin: false, insecure: false });
          }
        }}
        title={confirm?.kind === "origin" ? "确认更换对外地址" : "确认切到 https"}
        description={confirm?.message}
        confirmLabel="我已确认，继续保存"
        tone="danger"
        pending={confirming}
        error={confirmError}
        onConfirm={confirmAndRetry}
      >
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>所有 OAuth 回调、下载短链与重定向会立刻改用新地址。</li>
          <li>论坛侧登记的 redirect URI、插件里配置的商城地址要同步更新。</li>
          <li>协议变化会换掉会话 cookie 名：所有人需要重新登录。</li>
          <li>已签发但未使用的短链只在旧地址仍可路由时有效。</li>
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="恢复默认设置"
        description="删除这一行配置：对外地址回到 STORE_PUBLIC_URL 种子，下载有效期回到 30 分钟，限流回到环境变量/内置默认。"
        confirmLabel="恢复默认"
        tone="danger"
        pending={resetting}
        error={resetError}
        onConfirm={reset}
      />
    </div>
  );
}

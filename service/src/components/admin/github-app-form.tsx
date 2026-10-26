"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Loader2, Plus, PlugZap, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Field, FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";
import { Section } from "@/components/common/section";
import { SubmitButton } from "@/components/common/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { GithubAppKeyView, GithubAppView } from "@/lib/github/app-config";
import { jsonRequest } from "@/lib/http-client";

/**
 * The GitHub App editor.
 *
 * It reads like a checklist because this page is used once, carefully, by an operator with
 * the GitHub App settings page open in the other window: register two addresses, enter the
 * credentials, keep the signing keys straight, then prove it works. Everything secret is
 * write-only — the read model carries `webhookSecretSet` and a public-key fingerprint, never
 * the value — so "已设置" plus a placeholder is the strongest claim the UI can make.
 *
 * The install URL is derived from the slug, which is why it only appears once a slug is
 * stored: guessing it before that would hand out a 404.
 */

/** `YYYY-MM-DD HH:mm` in UTC — one clock, the server's, same as the audit log. */
function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().slice(0, 16).replace("T", " ");
}

/** A SHA-256 fingerprint is 64 hex chars; the list needs the ends, not the middle. */
function shortFingerprint(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
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

/**
 * What the manifest callback reported, rendered as a banner above the form.
 *
 * The callback answers with a redirect rather than this page (a refresh must not replay a
 * single-use code), so the outcome travels in the query string. Only the reason *code*
 * travels; the sentences live here, next to the button that starts the flow.
 */
export type ManifestOutcome = {
  status: "created" | "failed";
  reason: string | null;
  slug: string | null;
  appId: string | null;
  verified: boolean;
  replacedAppId: string | null;
};

/** One sentence per reason code the callback can hand back. */
const MANIFEST_FAILURES: Record<string, string> = {
  missing_params: "GitHub 回调里没有 code，这次跳转不完整。重新点一次「一键创建」即可。",
  state: "创建状态校验失败：cookie 已过期（一小时）或被改过。重新点一次「一键创建」。",
  session: "发起创建的管理员和完成回调的会话对不上，或会话已过期。重新登录后再点一次。",
  manifest_exchange_failed:
    "GitHub 拒绝把这个 code 换成凭据：code 只能用一次、一小时内有效。重新点一次「一键创建」；上一次已经建出来的 App 如果出现在 GitHub 上，先删掉它。",
  manifest_invalid_response:
    "GitHub 返回的凭据不完整（缺 App ID、slug、私钥或 webhook secret），没有写进配置。",
  manifest_requires_github_dot_com: "一键创建只支持 github.com，请用下面的手动填写。",
  invalid_owner: "组织名不合法：只能是字母、数字与连字符。",
};

export function GithubAppForm({
  view,
  publicUrl,
  production,
  manifestOutcome,
}: {
  view: GithubAppView;
  publicUrl: string;
  production: boolean;
  manifestOutcome: ManifestOutcome | null;
}) {
  const router = useRouter();
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;
  const formId = id("form");
  const keyFormId = id("key-form");

  const [appId, setAppId] = useState(view.appId === null ? "" : String(view.appId));
  const [slug, setSlug] = useState(view.slug ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(view.apiBaseUrl);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyPem, setKeyPem] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyTarget, setKeyTarget] = useState<GithubAppKeyView | null>(null);
  const [keyRemoving, setKeyRemoving] = useState(false);
  const [keyRemoveError, setKeyRemoveError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [owner, setOwner] = useState("");
  const [startingManifest, setStartingManifest] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);

  const lastKey = view.keys.length <= 1;

  /** One close path for the add-key dialog, so a pasted PEM never survives it. */
  function closeKeyDialog() {
    setKeyDialogOpen(false);
    setKeyPem("");
    setKeyError(null);
    setKeySaving(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setFormError(null);

    // Same rules the domain layer enforces, said before the round trip: a first save without
    // a webhook secret or a signing key produces an App that cannot receive or authenticate.
    if (!view.configured && !webhookSecret.trim()) {
      setFormError("首次配置必须填写 webhook secret：没有它 webhook 一律验签失败。");
      return;
    }
    if (!view.configured && !privateKeyPem.trim()) {
      setFormError("首次配置必须粘贴 private key：没有它签不出 App JWT。");
      return;
    }

    setSaving(true);
    const result = await jsonRequest<{ ok: true; addedKey: string | null }>(
      "/api/admin/github-app",
      "PUT",
      {
        appId: appId.trim(),
        slug: slug.trim(),
        apiBaseUrl: apiBaseUrl.trim(),
        webhookSecret: webhookSecret.trim() || undefined,
        privateKeyPem: privateKeyPem.trim() || undefined,
      },
    );
    setSaving(false);

    if (!result.ok) {
      setFormError(result.failure.message || "保存失败");
      return;
    }

    setAppId(appId.trim());
    setSlug(slug.trim());
    setApiBaseUrl(apiBaseUrl.trim());
    setWebhookSecret("");
    setPrivateKeyPem("");
    setVerifyResult(null);
    setVerifyError(null);
    toast.success(
      result.data.addedKey
        ? `已保存，私钥 ${result.data.addedKey} 已入库并开始签名`
        : "已保存",
    );
    router.refresh();
  }

  async function addKey(event: React.FormEvent) {
    event.preventDefault();
    if (keySaving) return;
    setKeyError(null);
    if (!keyPem.trim()) {
      setKeyError("请粘贴 private key 全文（-----BEGIN … PRIVATE KEY----- 到 END）。");
      return;
    }

    setKeySaving(true);
    const result = await jsonRequest<{ ok: true; appKeyId: string }>(
      "/api/admin/github-app/keys",
      "POST",
      { privateKeyPem: keyPem },
    );
    setKeySaving(false);

    if (!result.ok) {
      setKeyError(result.failure.message || "添加失败");
      return;
    }

    closeKeyDialog();
    toast.success(`私钥已添加：${result.data.appKeyId}，现在由它签名`);
    router.refresh();
  }

  async function removeKey() {
    if (!keyTarget || keyRemoving) return;
    const appKeyId = keyTarget.appKeyId;
    setKeyRemoving(true);
    setKeyRemoveError(null);

    const result = await jsonRequest<{ ok: true; remaining: number }>(
      `/api/admin/github-app/keys/${encodeURIComponent(appKeyId)}`,
      "DELETE",
    );
    setKeyRemoving(false);

    if (!result.ok) {
      setKeyRemoveError(result.failure.message || "删除失败");
      return;
    }

    setKeyTarget(null);
    toast.success(`已删除私钥 ${appKeyId}，还剩 ${result.data.remaining} 把`);
    router.refresh();
  }

  async function verify() {
    if (verifying) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);

    const result = await jsonRequest<{ ok: boolean; status: number | null; message: string }>(
      "/api/admin/github-app/verify",
      "POST",
    );
    setVerifying(false);

    if (!result.ok) {
      setVerifyError(result.failure.message || "验证请求失败");
      return;
    }

    setVerifyResult({ ok: result.data.ok, message: result.data.message });
    if (result.data.ok) toast.success("验证通过");
    router.refresh();
  }

  async function removeConfig() {
    if (removePending) return;
    setRemovePending(true);
    setRemoveError(null);

    const result = await jsonRequest<{ ok: true }>("/api/admin/github-app", "DELETE");
    setRemovePending(false);

    if (!result.ok) {
      setRemoveError(result.failure.message || "移除失败");
      return;
    }

    setRemoveOpen(false);
    setAppId("");
    setSlug("");
    setApiBaseUrl("https://api.github.com");
    setWebhookSecret("");
    setPrivateKeyPem("");
    setVerifyResult(null);
    setVerifyError(null);
    toast.success("GitHub App 配置已移除");
    router.refresh();
  }

  /**
   * Start the manifest handshake.
   *
   * Two steps, because GitHub wants a POST body and a redirect cannot carry one: ask this
   * origin for the target URL plus the preconfigured manifest, then submit a real form to
   * github.com. Everything after that happens on GitHub's own page — the person only confirms
   * the App name — and GitHub comes back to `/api/github/manifest/callback`.
   */
  async function startManifest() {
    if (startingManifest) return;
    setManifestError(null);
    setStartingManifest(true);

    const result = await jsonRequest<{ actionUrl: string; manifest: unknown }>(
      "/api/admin/github-app/manifest/start",
      "POST",
      { owner: owner.trim() || undefined },
    );

    if (!result.ok) {
      setStartingManifest(false);
      setManifestError(result.failure.message || "无法开始创建");
      return;
    }

    const form = document.createElement("form");
    form.method = "post";
    form.action = result.data.actionUrl;
    form.style.display = "none";

    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "manifest";
    field.value = JSON.stringify(result.data.manifest);
    form.appendChild(field);

    document.body.appendChild(form);
    form.submit();

    // If the submit is blocked the button must not stay dead forever; a real navigation
    // discards this timer along with the page.
    window.setTimeout(() => setStartingManifest(false), 8000);
  }

  return (
    <div className="space-y-7">
      {manifestOutcome?.status === "created" ? (
        <div
          role="status"
          className="rounded-control border border-success/40 bg-success/5 px-4 py-3 text-xs"
        >
          <p className="text-sm font-medium">GitHub 已经把这个 App 建好了</p>
          <p className="mt-1 leading-relaxed text-evidence-foreground">
            App ID {manifestOutcome.appId} · slug {manifestOutcome.slug} 已入库。webhook secret 与
            私钥是 GitHub 在创建时直接交给服务端的，没有经过你的手。
            {manifestOutcome.replacedAppId
              ? ` 原来配置的 App ${manifestOutcome.replacedAppId} 已被替换，它的私钥一并清除。`
              : ""}
            {manifestOutcome.verified
              ? " 验证已通过。"
              : " 但自动验证没有通过：看第 4 节「验证」的结果，通常是出站网络到 GitHub API 不通。"}
          </p>
          <p className="mt-1 leading-relaxed text-evidence-foreground">
            下一步：把第 1 节的安装链接发给要装扩展的仓库管理员；装完仓库就会出现在开发者门户里。
          </p>
        </div>
      ) : null}

      {manifestOutcome?.status === "failed" ? (
        <div
          role="alert"
          className="rounded-control border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive"
        >
          <p className="text-sm font-medium">一键创建没有完成</p>
          <p className="mt-1 leading-relaxed">
            {MANIFEST_FAILURES[manifestOutcome.reason ?? ""] ??
              "创建过程中出错了，具体原因记在服务端日志（[github] manifest callback）。"}
          </p>
        </div>
      ) : null}

      {view.readError ? (
        <div
          role="alert"
          className="rounded-control border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive"
        >
          <p className="text-sm font-medium">存储的配置读不出来</p>
          <p className="mt-1 leading-relaxed">{view.readError}</p>
          <p className="mt-1 leading-relaxed">
            webhook 验签、安装回调与下载代理现在都会失败。这是 STORE_SECRET_KEYS 与库里的密文
            对不上：把缺少的 kid 补回环境变量并重启，或在这里重新填一遍凭据（会覆盖）。
          </p>
        </div>
      ) : null}

      <Section
        id="github-quick-start"
        title="0. 一键创建（推荐）"
        hint="让 GitHub 按我们写好的配置建 App：权限、事件、Webhook URL 与 Setup URL 全部预填，建完把 App ID、slug、webhook secret 与私钥直接交回这里。走完这一步可以跳过下面第 1、2 节。"
      >
        <div className="surface space-y-4 px-4 py-4">
          <div className="surface-quiet px-3 py-2.5 text-[13px] leading-relaxed text-evidence-foreground">
            <p>
              <span className="font-medium">会预填</span>：Homepage URL · Webhook URL · Setup URL ·
              权限 Contents / Metadata / Actions 全部 read · 事件 release / installation /
              installation_repositories / repository · Public App。
            </p>
            <p className="mt-1">
              <span className="font-medium">Public 是必须的</span>：Private App 只有 App 所有者能
              安装，开发者就装不到自己的仓库上。
            </p>
            <p className="mt-1">
              <span className="font-medium">替换语义</span>：这里建的永远是新的 App。已经配过 App
              的话，旧配置连同它的私钥一起被清掉，装过的仓库要重装一次。
            </p>
          </div>

          <Field
            label="组织（可选）"
            htmlFor={id("owner")}
            hint="留空即建在你自己的 GitHub 账号下。填组织名即建在该组织下，你必须是该组织里能创建 App 的成员。"
          >
            <Input
              id={id("owner")}
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="例如 keeptrue"
              spellCheck={false}
              className="font-mono"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="button" onClick={startManifest} disabled={startingManifest}>
              {startingManifest ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Wand2 aria-hidden />
              )}
              {startingManifest ? "正在跳转 GitHub…" : "用 GitHub 创建并填好"}
            </Button>
            <p className="text-xs text-muted-foreground">
              会跳到 github.com：确认 App 名字（GitHub 会预填一个）后自动回到本页。
            </p>
          </div>

          {manifestError ? <FormError>{manifestError}</FormError> : null}
        </div>
      </Section>

      <Section
        id="github-urls"
        title="1. 先在 GitHub App 上登记地址与权限"
        hint="GitHub 侧要填三格：Webhook URL 在「Webhook」，Setup URL 在 App 设置页顶部，安装入口就是 App 的公开安装页。地址由 STORE_PUBLIC_URL 推导，不在这里改。"
      >
        <div className="surface space-y-4 px-4 py-4">
          <Field
            label="Webhook payload URL"
            htmlFor={id("webhook")}
            hint={`由 STORE_PUBLIC_URL（${publicUrl}）推导。Content type 选 application/json；同一串 secret 填在下面第 2 步。`}
          >
            <CopyValue
              id={id("webhook")}
              value={view.webhookUrl}
              label="复制 webhook 地址"
            />
          </Field>

          <Field
            label="Setup URL"
            htmlFor={id("setup")}
            hint="GitHub App 的「Setup URL」填这一串（不是 Callback URL）：安装完成后 GitHub 带着 installation_id 回到这里。填错的表现是装完停在 GitHub、本地没有 installation 记录。"
          >
            <CopyValue id={id("setup")} value={view.setupUrl} label="复制 Setup URL" />
          </Field>

          <Field
            label="Install link"
            htmlFor={view.installUrl ? id("install") : undefined}
            hint="给论坛管理员打开这个链接，选择站点仓库完成安装；installation 事件回来之后仓库才会出现在开发者门户里。"
          >
            {view.installUrl ? (
              <CopyValue
                id={id("install")}
                value={view.installUrl}
                label="复制安装链接"
              />
            ) : (
              <p className="surface-dashed px-2.5 py-1.5 font-mono text-[12.5px] text-muted-foreground">
                保存 slug 后生成
              </p>
            )}
          </Field>

          <div className="surface-quiet px-3 py-2.5 text-[13px] leading-relaxed text-evidence-foreground">
            <p>
              <span className="font-medium">权限</span>：Contents read · Metadata read · Actions
              read。不要申请 Administration——商城不写仓库。
            </p>
            <p className="mt-1">
              <span className="font-medium">事件</span>：release · installation ·
              installation_repositories · repository。少订 repository 会让仓库改名、转移或转私有
              静默失效。
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="github-credentials"
        title="2. 填写 App 凭据"
        hint="App ID 是 GitHub App 设置页顶部的数字，不是 client_id。密钥类字段只写不读：保存后本页只知道「有没有」，原文不再返回。"
      >
        <form
          id={formId}
          onSubmit={submit}
          className="surface space-y-4 px-4 py-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="App ID"
              htmlFor={id("appId")}
              required
              hint="纯数字，例如 123456。填错时「验证」会拿不到 App JWT。"
            >
              <Input
                id={id("appId")}
                type="number"
                inputMode="numeric"
                min={1}
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="123456"
                required
                spellCheck={false}
                className="font-mono"
              />
            </Field>

            <Field
              label="slug"
              htmlFor={id("slug")}
              required
              hint="App 的 URL 名：github.com/apps/<slug>。安装链接由它拼出来，填错只有安装页 404，「验证」会明确报 slug 不匹配。"
            >
              <Input
                id={id("slug")}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="sforum-store"
                required
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          </div>

          <Field
            label="API base URL"
            htmlFor={id("apiBaseUrl")}
            hint={`默认 https://api.github.com。只有 GitHub Enterprise Server 才需要改；${
              production ? "生产环境必须使用 https。" : "本地 127.0.0.1 / localhost 允许 http。"
            }`}
          >
            <Input
              id={id("apiBaseUrl")}
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="https://api.github.com"
              spellCheck={false}
              className="font-mono"
            />
          </Field>

          <Field
            label="Webhook secret"
            htmlFor={id("secret")}
            required={!view.configured}
            hint={
              view.webhookSecretSet
                ? "已设置。留空表示不修改；填新值即轮换，GitHub 与商城要同时改，否则下一次投递全部验签失败。"
                : "16–256 字符，用 openssl rand -hex 32 生成。同一串要填进 GitHub App 的 Webhook secret。"
            }
          >
            <Input
              id={id("secret")}
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              autoComplete="new-password"
              placeholder={view.webhookSecretSet ? "留空表示不修改" : ""}
              required={!view.configured}
            />
          </Field>

          <Field
            label="Private key"
            htmlFor={id("key")}
            required={!view.configured}
            hint={
              view.configured
                ? "粘贴 .private-key.pem 全文即新增一把（新键立即签名，旧键保留到 GitHub 侧删除）。留空表示不修改。"
                : "粘贴 .private-key.pem 全文（PKCS#8 或 PKCS#1，未加密）。加密存储，保存后永不显示；列表里只留公钥指纹。"
            }
          >
            <Textarea
              id={id("key")}
              value={privateKeyPem}
              onChange={(event) => setPrivateKeyPem(event.target.value)}
              rows={5}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                view.configured
                  ? "留空表示不修改"
                  : "-----BEGIN RSA PRIVATE KEY----- … -----END RSA PRIVATE KEY-----"
              }
              className="font-mono text-[12.5px]"
            />
          </Field>

          {formError ? <FormError>{formError}</FormError> : null}

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pending={saving} pendingLabel="保存中…">
              {view.configured ? "保存修改" : "保存并启用"}
            </SubmitButton>
            <p className="text-[12.5px] text-muted-foreground">
              保存会清空上一次的验证结果：改过的凭据还没被验证过。
            </p>
          </div>
        </form>
      </Section>

      <Section
        id="github-keys"
        title="3. 签名私钥与轮换"
        hint="轮换是「先加后删」：最新一把签名，旧的留着直到 GitHub 侧删掉。最后一把不能删——没有签名私钥就签不出 App JWT，本页的「验证」也救不回来。"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-foreground"
            onClick={() => {
              setKeyError(null);
              setKeyPem("");
              setKeyDialogOpen(true);
            }}
            disabled={!view.configured}
            title={view.configured ? undefined : "先保存上面的配置"}
          >
            <Plus className="size-3.5" aria-hidden />
            添加私钥
          </Button>
        }
      >
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">GitHub App 签名私钥</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  appKeyId
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
                  公钥指纹
                </th>
                <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">
                  创建（UTC）
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  状态
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {view.keys.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-8 text-center text-sm text-muted-foreground"
                  >
                    {view.configured
                      ? "配置已保存但没有任何私钥：webhook 与下载代理都会失败，请立刻添加一把。"
                      : "还没有私钥。保存第 2 步的表单时会一起入库。"}
                  </td>
                </tr>
              ) : (
                view.keys.map((key) => (
                  <tr key={key.appKeyId}>
                    <td className="px-3 py-2.5 font-mono text-[12.5px]">{key.appKeyId}</td>
                    <td
                      className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground md:table-cell"
                      title={key.fingerprint}
                    >
                      {shortFingerprint(key.fingerprint)}
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground sm:table-cell">
                      {formatTime(key.createdAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      {key.signing ? (
                        <Badge variant="success">签名中</Badge>
                      ) : (
                        <Badge variant="muted">备用</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={lastKey}
                        title={
                          lastKey
                            ? "最后一把私钥不能删除：没有它拿不到 App JWT。先添加新的，再删旧的。"
                            : undefined
                        }
                        onClick={() => {
                          setKeyRemoveError(null);
                          setKeyTarget(key);
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        删除
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {view.keys.length === 1 ? (
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            只剩一把私钥，删除已禁用：没有签名私钥就签不出 App JWT，webhook 验签与下载代理会一起
            停摆。要换键请先「添加私钥」，确认新键显示「签名中」之后再删旧的。
          </p>
        ) : null}
      </Section>

      <Section
        id="github-verify"
        title="4. 验证连通性"
        hint="用存好的凭据签一个 App JWT 请求 GET /app：一次证明 app id 存在、私钥配对、slug 与 GitHub 上的一致。失败只记录，不拦任何功能。"
      >
        <div className="surface space-y-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={verify}
              disabled={verifying || !view.configured}
              title={view.configured ? undefined : "先保存配置再验证"}
            >
              {verifying ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <PlugZap aria-hidden />
              )}
              {verifying ? "验证中…" : "验证"}
            </Button>
            <p className="text-[12.5px] text-muted-foreground">
              上次成功：{formatTime(view.lastVerifiedAt)}
              {view.updatedAt ? ` · 配置更新于 ${formatTime(view.updatedAt)}` : ""}
            </p>
          </div>

          {verifyError ? <FormError>{verifyError}</FormError> : null}

          {verifyResult ? (
            <p
              role="status"
              className={
                verifyResult.ok
                  ? "rounded-control border border-success/40 bg-success/5 px-3 py-2 text-xs leading-relaxed text-success"
                  : "rounded-control border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
              }
            >
              {verifyResult.message}
            </p>
          ) : null}

          {view.lastError && !verifyResult ? (
            <div className="rounded-control border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <p className="font-medium">上次验证失败</p>
              <p className="mt-0.5 leading-relaxed">{view.lastError}</p>
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        id="github-remove"
        title="5. 移除配置"
        hint="只有确实要断开这个 App 时才用。移除后 webhook 验签、安装回调与下载代理立刻停止。"
      >
        <div className="surface flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <p className="max-w-[62ch] text-xs leading-relaxed text-muted-foreground">
            已安装的 installation 与已同步的仓库记录保留：它们只是历史。重新填同一个 App
            会直接接回；换成另一个 App 则要等 GitHub 重新投递 installation 事件。
          </p>
          <Button
            type="button"
            variant="outline"
            className="text-destructive"
            onClick={() => {
              setRemoveError(null);
              setRemoveOpen(true);
            }}
            disabled={!view.configured}
          >
            <Trash2 aria-hidden />
            移除配置
          </Button>
        </div>
      </Section>

      <Modal
        open={keyDialogOpen}
        onOpenChange={(next) => {
          if (next) setKeyDialogOpen(true);
          else closeKeyDialog();
        }}
        title="添加签名私钥"
        description="只写不读：入库后本页只保留 appKeyId 与公钥指纹。最新添加的一把立即开始签名。"
        size="lg"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={closeKeyDialog}>
              取消
            </Button>
            <SubmitButton form={keyFormId} pending={keySaving} pendingLabel="添加中…">
              添加
            </SubmitButton>
          </>
        }
      >
        <form id={keyFormId} onSubmit={addKey} className="space-y-3" noValidate>
          <Field
            label="private key（PEM）"
            htmlFor={id("newKey")}
            required
            hint="-----BEGIN RSA PRIVATE KEY----- 到 END 的全文，未加密。同一把重复粘贴会被拒（指纹就是 id）。"
          >
            <Textarea
              id={id("newKey")}
              value={keyPem}
              onChange={(event) => setKeyPem(event.target.value)}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12.5px]"
              autoFocus
            />
          </Field>
          {keyError ? <FormError>{keyError}</FormError> : null}
        </form>
      </Modal>

      <ConfirmDialog
        open={keyTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setKeyTarget(null);
            setKeyRemoveError(null);
            setKeyRemoving(false);
          }
        }}
        title={`删除私钥 ${keyTarget?.appKeyId ?? ""}？`}
        description="GitHub 上若还保留着这把私钥，删除后它就不能再用来签名。轮换时先确认新私钥已经在列表里并显示「签名中」。"
        confirmLabel="删除"
        tone="danger"
        pending={keyRemoving}
        error={keyRemoveError}
        onConfirm={() => void removeKey()}
      />

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={(next) => {
          setRemoveOpen(next);
          if (!next) {
            setRemoveError(null);
            setRemovePending(false);
          }
        }}
        title="移除 GitHub App 配置？"
        description="App ID、slug、API 地址、webhook secret 与全部私钥会从数据库删除，webhook 验签和下载代理随即停止。GitHub 上已安装的 installation 与已同步的仓库记录保留。"
        confirmLabel="移除配置"
        tone="danger"
        pending={removePending}
        error={removeError}
        onConfirm={() => void removeConfig()}
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          这一步不能撤销：私钥删除后只能用 GitHub 上的原件重新粘贴。
        </p>
      </ConfirmDialog>
    </div>
  );
}

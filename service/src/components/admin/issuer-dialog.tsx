"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";
import { SubmitButton } from "@/components/common/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IssuerRow } from "@/lib/admin/issuers";
import { jsonRequest } from "@/lib/http-client";

/**
 * Create or edit one OAuth2 issuer.
 *
 * The secret is write-only: the form never receives the stored value, and leaving the field
 * empty keeps the current ciphertext. Rotating is the provider's own model (single hash,
 * no dual-secret grace), so there is no "confirm old secret" step to offer.
 *
 * Field hints carry the numbers the provider actually enforces (`sforum-oauth2-provider`:
 * `client_id` 8..128 and `client_secret` ≤256 in `schemas/token.request.json`; the client id
 * the plugin mints is `sfo_client_` + 24 hex, the secret `sfos_` + 64 hex).
 */
const KNOWN_SCOPES = [
  "profile",
  "email",
  "avatar",
  "topic.count",
  "comment.count",
  "users.groups",
] as const;

const RECOMMENDED = "profile avatar";

function splitScopes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function CopyCallback({ value }: { value: string }) {
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
      <Input value={value} readOnly spellCheck={false} className="font-mono text-[12.5px]" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={copy}
        aria-label="复制回调地址"
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

export function IssuerDialog({
  open,
  issuer,
  callbackUrl,
  onOpenChange,
}: {
  open: boolean;
  issuer: IssuerRow | null;
  callbackUrl: string;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const fieldId = useId();
  const formId = `${fieldId}-form`;
  const editing = issuer !== null;

  const [issuerKey, setIssuerKey] = useState(issuer?.issuerKey ?? "");
  const [displayName, setDisplayName] = useState(issuer?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(issuer?.baseUrl ?? "");
  const [clientId, setClientId] = useState(issuer?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(
    (issuer?.scopes ?? ["profile", "avatar"]).join(" "),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = (name: string) => `${fieldId}-${name}`;
  const unknownScopes = splitScopes(scopes).filter(
    (scope) => !KNOWN_SCOPES.includes(scope as (typeof KNOWN_SCOPES)[number]),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (!editing && !clientSecret.trim()) {
      setError("新建时必须填写 client_secret。");
      return;
    }

    setPending(true);
    const payload = {
      issuerKey: issuerKey.trim(),
      displayName: displayName.trim(),
      baseUrl: baseUrl.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: splitScopes(scopes),
    };

    const result = editing
      ? await jsonRequest(
          `/api/admin/issuers/${encodeURIComponent(issuer.issuerKey)}`,
          "PATCH",
          payload,
        )
      : await jsonRequest("/api/admin/issuers", "POST", payload);

    setPending(false);
    if (!result.ok) {
      setError(result.failure.message || "保存失败");
      return;
    }

    toast.success(editing ? "issuer 已更新" : "issuer 已创建");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `编辑 ${issuer.issuerKey}` : "新增 OAuth2 issuer"}
      description="参数来自论坛后台「OAuth2 应用」页。client_secret 只写不读，保存后不会再显示。"
      size="lg"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <SubmitButton form={formId} pending={pending} pendingLabel="保存中…">
            保存
          </SubmitButton>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3" noValidate>
        <Field
          label="回调地址（登记到 SForum 的那一串）"
          htmlFor={id("callback")}
          hint="provider 精确匹配，多一个斜杠都不行；生产必须 https。这一串由 STORE_PUBLIC_URL 推导，不在这里改。"
        >
          <CopyCallback value={callbackUrl} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="issuer_key"
            htmlFor={id("key")}
            required
            hint="内部标识，如 official。创建后不可改；账号唯一键是 (issuer_key, sub)。"
          >
            <Input
              id={id("key")}
              value={issuerKey}
              onChange={(event) => setIssuerKey(event.target.value)}
              readOnly={editing}
              required
              spellCheck={false}
              className="font-mono"
            />
          </Field>

          <Field label="显示名" htmlFor={id("name")} hint="只用于后台展示，例如「官方论坛」。">
            <Input
              id={id("name")}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="官方论坛"
            />
          </Field>
        </div>

        <Field
          label="论坛地址（base_url）"
          htmlFor={id("base")}
          required
          hint="SForum 站点根地址，不带路径。商城会请求 <base_url>/api/oauth/{csrf,authorize,token,userinfo,revoke}；生产必须 https，本地 127.0.0.1 / localhost 允许 http。"
        >
          <Input
            id={id("base")}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://forum.example.com"
            required
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <Field
          label="client_id"
          htmlFor={id("client")}
          required
          hint="SForum 应用创建后一次性显示的 sfo_client_…（35 字符）。8–128 是 provider 的 schema 下限，短于 8 位每次登录都会 422。"
        >
          <Input
            id={id("client")}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            required
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <Field
          label="client_secret"
          htmlFor={id("secret")}
          required={!editing}
          hint={
            editing
              ? "sfos_…（69 字符）。填新值即轮换：provider 单哈希覆盖，没有双 secret 宽限；刷新令牌绑 client_id，轮换不会把用户踢下线。留空表示不修改。"
              : "sfos_…（69 字符），只在论坛创建应用或重置密钥时显示一次。最多 256 字符。"
          }
        >
          <Input
            id={id("secret")}
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            autoComplete="new-password"
            placeholder={editing ? "留空表示不修改" : ""}
            required={!editing}
          />
        </Field>

        <Field
          label="scopes"
          htmlFor={id("scopes")}
          hint="空格或逗号分隔。必须与 SForum 应用勾选的范围一致，且 ⊆ 站点「OAuth2 设置」的 allowed_scopes；profile 恒被授予，会自动补上。商城只消费 profile（身份）与 avatar（头像），email 可选，其余三项不读。"
        >
          <div className="space-y-1.5">
            <Input
              id={id("scopes")}
              value={scopes}
              onChange={(event) => setScopes(event.target.value)}
              className="font-mono"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setScopes(RECOMMENDED)}
              >
                用推荐范围（{RECOMMENDED}）
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setScopes(`${RECOMMENDED} email`)}
              >
                再加 email
              </Button>
            </div>
            {unknownScopes.length > 0 ? (
              <p className="text-[13px] leading-relaxed text-warning">
                {unknownScopes.join("、")} 不在 provider 的 scope 注册表里（profile / email /
                avatar / topic.count / comment.count / users.groups）：保存不拦，但授权时会返回
                invalid_scope。
              </p>
            ) : null}
          </div>
        </Field>

        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Modal>
  );
}

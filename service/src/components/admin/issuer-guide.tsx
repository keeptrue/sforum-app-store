"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Info } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The "how to fill the SForum form" panel.
 *
 * Every value below is read from the provider implementation, not invented:
 * `sforum-oauth2-provider/plugins/sforum-oauth2-provider/frontend/admin/dist/clients.mjs`
 * (field labels and the redirect-URI rule), `backend/clients.go#buildClient` (1–10 redirect
 * URIs, https or loopback http, ≤120-char name), `backend/oauth2.go#matchRedirectURI`
 * (exact match, no fragment) and `backend/constants.go#scopeRegistry` (the six scopes).
 *
 * It lives next to the form because the two halves of this setup happen on two different
 * machines, and the store side is where people get stuck.
 */
const SCOPES = [
  {
    name: "profile",
    verdict: "必选",
    note: "身份基底：用户名、昵称、注册时间、账号状态。商城用它建账号（唯一键 issuer_key + sub）。",
  },
  {
    name: "avatar",
    verdict: "勾选",
    note: "头像地址。商城把它写进 accounts.avatar_url；不勾就只有默认头像。",
  },
  {
    name: "email",
    verdict: "可选",
    note: "邮箱与验证状态。授权时读取一次并存快照；论坛需已授予 users.email.read 能力，否则授权失败。",
  },
  {
    name: "topic.count",
    verdict: "不要勾",
    note: "主题数。商城的 userinfo 映射里没有这个字段，勾了只是让确认页多一行授权。",
  },
  {
    name: "comment.count",
    verdict: "不要勾",
    note: "回帖数。同上，商城不读。",
  },
  {
    name: "users.groups",
    verdict: "不要勾",
    note: "用户组徽章。商城不读；商城角色来自本地 store_roles，不从论坛用户组推导。",
  },
] as const;

const FAILURES = [
  ["invalid_client", "client_id 不存在，或 client_secret 不匹配（密钥被重置过就要同步更新）。"],
  ["invalid_scope", "请求的 scope 超出该应用勾选的范围，或超出站点「OAuth2 设置」里的 allowed_scopes。"],
  ["invalid_grant", "授权码过期/已用、redirect_uri 与授权请求不一致、PKCE 校验失败。"],
  ["422 route_schema_invalid", "请求体不符合 provider 的 JSON schema：client_id 短于 8 字符、发了空字符串字段、用了表单编码。"],
  ["403 client_creation_forbidden / client_creation_disabled", "建应用的人没有权限，或站点关闭了「允许用户自助创建应用」。"],
  ["404（测试连接）", "地址可达但没有 /api/oauth/csrf：论坛没装 sforum-oauth2-provider。"],
] as const;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={label}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

export function IssuerGuide({
  callbackUrl,
  defaultOpen,
}: {
  callbackUrl: string;
  defaultOpen: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="mb-5 surface-quiet px-4 py-3 text-evidence-foreground"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium">
        <Info aria-hidden className="size-4" />
        在 SForum 里怎么建这个 OAuth2 应用
        <span className="text-[12.5px] font-normal opacity-80">
          8 步，字段名与论坛后台一一对应
        </span>
      </summary>

      <div className="mt-3 space-y-4 text-xs leading-relaxed">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            论坛后台 → 分组 <span className="font-mono">OAuth2</span> → 页面{" "}
            <span className="font-mono">OAuth2 应用</span>（插件{" "}
            <span className="font-mono">sforum-oauth2-provider</span> 的{" "}
            <span className="font-mono">/clients</span>）。需要{" "}
            <span className="font-mono">sforum.oauth2-provider.manage_clients</span>；站点开着
            「允许用户自助创建应用」时，持{" "}
            <span className="font-mono">create_clients</span> 权限的登录用户也能建。
          </li>
          <li>
            <strong>应用名称</strong>：填商城名字，例如{" "}
            <span className="font-mono">应用商城</span>。这一行会显示在用户的授权确认页上。
          </li>
          <li>
            <strong>客户端类型</strong>：选 <strong>机密（confidential）</strong>。商城在服务端换
            token，必须持有 <span className="font-mono">client_secret</span>；公开客户端拿不到密钥，
            接不上。
          </li>
          <li>
            <strong>回调地址</strong>：只填下面这一串，逐字一致。
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[12.5px]">
                {callbackUrl}
              </code>
              <CopyButton value={callbackUrl} label="复制回调地址" />
            </div>
            <p className="mt-1.5 opacity-80">
              provider 做精确匹配：不做通配、不做路径前缀、不接受 <span className="font-mono">#fragment</span>，
              多一个结尾斜杠就是另一个地址。生产必须 <span className="font-mono">https</span>；本地开发
              只放行 <span className="font-mono">http://127.0.0.1</span> /{" "}
              <span className="font-mono">http://localhost</span>。一个应用最多登记 10 个回调地址。
            </p>
          </li>
          <li>
            <strong>权限范围</strong>：勾 <span className="font-mono">profile</span> 与{" "}
            <span className="font-mono">avatar</span>；需要邮箱再加{" "}
            <span className="font-mono">email</span>。这里勾的范围就是该应用能申请的<b>上限</b>，
            也是商城不带 scope 时的默认值——勾少了商城会收到{" "}
            <span className="font-mono">invalid_scope</span>。逐项判断见下表。
          </li>
          <li>
            <strong>创建后立刻复制</strong> <span className="font-mono">client_id</span>（形如{" "}
            <span className="font-mono">sfo_client_</span> + 24 位十六进制，共 35 字符）和{" "}
            <span className="font-mono">client_secret</span>（形如{" "}
            <span className="font-mono">sfos_</span> + 64 位十六进制，共 69 字符）。
            密钥只显示这一次，关掉就只能「重置密钥」。
          </li>
          <li>
            回到本页 <strong>新增 issuer</strong>，填 <span className="font-mono">issuer_key</span>
            （内部标识，如 <span className="font-mono">official</span>）、论坛地址、
            <span className="font-mono">client_id</span>、<span className="font-mono">client_secret</span>、
            scopes，保存后点 <strong>测试连接</strong>。
          </li>
          <li>
            用论坛账号打开 <span className="font-mono">/dashboard</span> 走一次完整登录。
          </li>
        </ol>

        <div className="surface overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">SForum 权限范围选择</caption>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="px-2.5 py-1.5 font-medium">scope</th>
                <th scope="col" className="px-2.5 py-1.5 font-medium">勾不勾</th>
                <th scope="col" className="px-2.5 py-1.5 font-medium">商城拿它做什么</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {SCOPES.map((scope) => (
                <tr key={scope.name}>
                  <td className="whitespace-nowrap px-2.5 py-1.5 font-mono">{scope.name}</td>
                  <td className="whitespace-nowrap px-2.5 py-1.5">{scope.verdict}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{scope.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <p className="mb-1.5 font-medium">登录失败时先看这里</p>
          <div className="surface overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <caption className="sr-only">provider 错误码</caption>
              <tbody className="divide-y divide-border">
                {FAILURES.map(([code, meaning]) => (
                  <tr key={code}>
                    <td className="whitespace-nowrap px-2.5 py-1.5 font-mono align-top">{code}</td>
                    <td className="px-2.5 py-1.5 text-muted-foreground">{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="flex flex-wrap items-center gap-1.5 opacity-80">
          <ExternalLink aria-hidden className="size-3.5" />
          论坛侧还有一份接入说明页：
          <span className="font-mono">&lt;论坛地址&gt;/docs/oauth2-provider</span>
          （数据来自插件自身的 <span className="font-mono">GET /api/oauth/docs</span>）。
        </p>

        <p className="surface px-2.5 py-1.5">
          <strong>一个商城只接入一个论坛。</strong>换论坛 = 先停用当前的 issuer，再建新的；账号不合并，
          旧论坛的用户与商品归属按 <span className="font-mono">issuer_key</span> 保留。
        </p>
      </div>
    </details>
  );
}

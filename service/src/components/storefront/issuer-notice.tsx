import { KeyRound } from "lucide-react";

/**
 * The login entry (`/dashboard`) redirects back here when the store cannot start an OAuth2
 * flow. Before this existed the redirect landed on a normal catalog page and said nothing —
 * the operator saw "the button does nothing" with no clue which side was misconfigured.
 *
 * Every code here is an operator problem, so the copy names the exact screen to fix.
 */
export type IssuerNoticeCode = "no_issuer" | "multiple_issuers" | "unknown_issuer";

const COPY: Record<IssuerNoticeCode, { title: string; body: string }> = {
  no_issuer: {
    title: "还没有配置登录来源",
    body: "管理员需要在后台「OAuth2 配置」里添加论坛的 OAuth2 应用；在这一步完成之前，论坛用户无法登录开发者门户。",
  },
  multiple_issuers: {
    title: "登录来源不止一个",
    body: "商城只允许一个启用中的 issuer。管理员需要在后台停用多余的，只保留当前论坛那一个。",
  },
  unknown_issuer: {
    title: "登录链接已失效",
    body: "链接里的 issuer 不存在或已停用。从开发者门户重新进入即可，不需要改地址。",
  },
};

/** Narrow `?error=` to a code this banner knows, so a stray query string renders nothing. */
export function issuerNoticeCode(value: unknown): IssuerNoticeCode | null {
  return typeof value === "string" && value in COPY
    ? (value as IssuerNoticeCode)
    : null;
}

export function IssuerNotice({ code }: { code: IssuerNoticeCode }) {
  const copy = COPY[code];
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-start gap-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <KeyRound aria-hidden className="mt-0.5 size-4 text-warning" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {copy.title}
          <span className="rounded-[6px] border border-warning/30 bg-warning/10 px-1.5 py-[2px] font-mono text-[12px] font-normal text-warning">
            {code}
          </span>
        </p>
        <p className="mt-1 max-w-[78ch] text-xs leading-relaxed text-muted-foreground">
          {copy.body}
        </p>
      </div>
    </div>
  );
}

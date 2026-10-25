import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AUDIT_TARGET_TYPES, type AuditFilterValues } from "@/lib/admin/audit";

/**
 * Audit filters as a plain GET form: no client state, no fetch, and every filter combination is
 * a URL the operator can bookmark or paste into a ticket.
 */

const TARGET_TYPE_LABELS: Record<(typeof AUDIT_TARGET_TYPES)[number], string> = {
  admin: "管理员",
  account: "论坛账号",
  github_app: "GitHub App",
  issuer: "OAuth2 issuer",
  product: "产品",
  release_version: "版本",
  session: "会话",
  store_settings: "系统设置",
};

/**
 * Hints, not a whitelist: the action column is free text written by many call sites, so the
 * filter accepts anything and only *suggests* the values that dominate the table.
 */
const COMMON_ACTIONS = [
  "admin.login.succeeded",
  "admin.login.failed",
  "admin.account.created",
  "admin.role.granted",
  "admin.session.revoked",
  "product.approved",
  "product.rejected",
  "release_version.yanked",
  "auth.login.succeeded",
];

export function AuditFilterForm({
  base,
  values,
}: {
  base: string;
  values: AuditFilterValues;
}) {
  const dirty =
    values.actor !== "" ||
    values.action !== "" ||
    values.targetType !== "" ||
    values.from !== "" ||
    values.to !== "";

  return (
    <form
      method="get"
      action={`${base}/audit`}
      className="mb-4 surface p-3"
      aria-label="审计日志筛选"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-muted-foreground">操作人</span>
          <Input
            name="actor"
            defaultValue={values.actor}
            placeholder="管理员名或论坛账号"
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-muted-foreground">动作</span>
          <Input
            name="action"
            defaultValue={values.action}
            placeholder="如 product.approved"
            list="audit-action-hints"
            autoComplete="off"
            className="font-mono"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-muted-foreground">目标类型</span>
          <Select name="targetType" defaultValue={values.targetType}>
            <option value="">全部</option>
            {AUDIT_TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {TARGET_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-muted-foreground">起始日（UTC）</span>
          <Input name="from" type="date" defaultValue={values.from} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-muted-foreground">截止日（UTC）</span>
          <Input name="to" type="date" defaultValue={values.to} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm">
          筛选
        </Button>
        {dirty ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`${base}/audit`}>清除筛选</Link>
          </Button>
        ) : null}
        <p className="text-[12.5px] text-muted-foreground">
          动作支持部分匹配；时间按 UTC 整日边界，起止当天都算在内。常见动作：
          <span className="font-mono">admin.login.succeeded</span>、
          <span className="font-mono">product.approved</span>、
          <span className="font-mono">release_version.yanked</span>。
        </p>
      </div>

      <datalist id="audit-action-hints">
        {COMMON_ACTIONS.map((action) => (
          <option key={action} value={action} />
        ))}
      </datalist>
    </form>
  );
}

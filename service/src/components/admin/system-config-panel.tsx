import { Badge } from "@/components/ui/badge";
import { PanelError, SystemPanel } from "@/components/admin/system-panel";
import type { ConfigHealth, Section } from "@/lib/admin/system";

/**
 * Configuration self-check. Presence only: `client_secret` never leaves the database, and the
 * setup token is reported as a boolean so a screenshot of this page cannot leak either.
 */
export function SystemConfigPanel({ data }: { data: Section<ConfigHealth> }) {
  return (
    <SystemPanel id="config" title="配置自检" hint="只显示是否配置，不显示值">
      {data.ok ? (
        <ConfigBody data={data.value} />
      ) : (
        <PanelError label="配置自检" message={data.error} />
      )}
    </SystemPanel>
  );
}

/**
 * The App moved out of env on 2026-10-25: this row reports what the database holds (app id,
 * slug, key count, last verification) and nothing that could be replayed.
 */
function GithubAppRow({ data }: { data: ConfigHealth }) {
  if (data.githubError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">GitHub App</p>
          <p className="mt-0.5 font-mono text-[12.5px] break-all text-destructive">
            {data.githubError}
          </p>
        </div>
        <Badge variant="muted">读取失败</Badge>
      </div>
    );
  }

  const github = data.github;
  if (!github) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">GitHub App</p>
          <p className="mt-0.5 text-sm">
            后台尚未配置：webhook、仓库同步与下载代理都不可用
          </p>
        </div>
        <Badge variant="muted">未配置</Badge>
      </div>
    );
  }

  const broken = github.readError !== null || github.keyCount === 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">GitHub App</p>
          <p className="mt-0.5 text-sm">
            <span className="font-mono text-[12.5px]">{github.slug}</span>
            <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
              app {github.appId}
            </span>
          </p>
        </div>
        <Badge variant={broken ? "warning" : "success"}>
          {broken ? "配置不完整" : "已配置"}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{github.keyCount} 把私钥</Badge>
        <Badge variant={github.webhookSecretSet ? "outline" : "warning"}>
          webhook secret {github.webhookSecretSet ? "已设置" : "缺失"}
        </Badge>
        <Badge variant={github.lastVerifiedAt ? "success" : "muted"}>
          {github.lastVerifiedAt ? "已连通" : "未验证"}
        </Badge>
        {github.apiBaseUrl !== "https://api.github.com" ? (
          <Badge variant="warning">{github.apiBaseUrl}</Badge>
        ) : null}
      </div>

      {github.readError ? (
        <p role="alert" className="text-[13px] leading-relaxed text-destructive">
          {github.readError}
        </p>
      ) : null}
      {github.lastError ? (
        <p className="font-mono text-[12.5px] break-all text-muted-foreground">
          {github.lastError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The address the service believes it lives on, and which layer answered. A mismatch with the
 * address bar is the "login does nothing" symptom, so it belongs on the health page too —
 * `/api/health` reports the same value for anyone arriving from outside.
 */
function PublicUrlRow({ data }: { data: ConfigHealth }) {
  if (data.runtimeError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">对外地址</p>
          <p className="mt-0.5 font-mono text-[12.5px] break-all text-destructive">
            {data.runtimeError}
          </p>
        </div>
        <Badge variant="muted">读取失败</Badge>
      </div>
    );
  }

  const runtime = data.runtime;
  if (!runtime) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">对外地址</p>
          <p className="mt-0.5 text-sm">读不到当前生效值</p>
        </div>
        <Badge variant="warning">未知</Badge>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">对外地址</p>
        <p className="mt-0.5 font-mono text-[12.5px] break-all">{runtime.publicUrl}</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          {runtime.updatedAt
            ? `上次修改 ${runtime.updatedAt.slice(0, 16).replace("T", " ")} UTC`
            : "尚未在后台修改过"}
        </p>
      </div>
      <Badge variant={runtime.source === "database" ? "success" : "muted"}>
        {runtime.source === "database" ? "后台设置" : "env 种子"}
      </Badge>
    </div>
  );
}

function ConfigBody({ data }: { data: ConfigHealth }) {
  return (
    <div className="space-y-4">
      <PublicUrlRow data={data} />
      <div className="border-t border-border pt-3">
        <GithubAppRow data={data} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">STORE_ADMIN_SETUP_TOKEN</p>
          <p className="mt-0.5 text-sm">
            {data.setupTokenConfigured
              ? "仍配置：首个管理员已存在后 setup 入口按「有 admin 行」关闭"
              : "未配置：注册首个管理员的入口是关闭的"}
          </p>
        </div>
        <Badge variant={data.setupTokenConfigured ? "warning" : "muted"}>
          {data.setupTokenConfigured ? "已配置" : "未配置"}
        </Badge>
      </div>

      <div className="border-t border-border pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">OAuth2 issuer</p>
          {data.issuers ? (
            <span className="font-mono text-[12.5px] text-muted-foreground">
              {data.issuers.active} active / {data.issuers.total} 总数
            </span>
          ) : null}
        </div>

        {data.issuersError ? (
          <p className="font-mono text-[12.5px] break-all text-destructive">
            {data.issuersError}
          </p>
        ) : data.issuers && data.issuers.active > 1 ? (
          <p
            role="alert"
            className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] leading-relaxed"
          >
            有 {data.issuers.active} 个启用中的 issuer：商城只允许一个登录来源，登录已被暂停。
            到「OAuth2 配置」停用多余的（迁移遗留数据）。
          </p>
        ) : null}

        {data.issuersError ? null : data.issuers && data.issuers.items.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.issuers.items.map((issuer) => (
              <li
                key={issuer.issuerKey}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {issuer.displayName}
                  <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
                    {issuer.issuerKey}
                  </span>
                </span>
                <Badge variant={issuer.status === "active" ? "success" : "muted"}>
                  {issuer.status === "active" ? "启用" : "已停用"}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            没有配置任何 issuer：论坛用户此刻无法登录开发者门户。
          </p>
        )}
      </div>

      <p className="text-[12.5px] text-muted-foreground">
        client_secret 与私钥永远不出库；这里只有「有没有配」。
      </p>
    </div>
  );
}

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { findSession, listActiveIssuers } from "@/lib/auth/service";
import { readAuthRequest } from "@/lib/install-auth/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Deliberately not indexed: a connect URL is a one-shot invitation, and a crawler that
 * followed one would both burn the request and put it in a search index.
 */
export const metadata: Metadata = {
  title: "连接商城",
  robots: { index: false, follow: false },
};

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ done?: string }>;
};

/**
 * `/connect/{id}` — the approval half of the install gate.
 *
 * The page answers one question for the operator: "this forum wants to install extensions
 * from this store as @you — allow it?" Everything it shows (account, issuer, plugin label,
 * short code) exists so a request the operator did *not* start is recognisable as such.
 *
 * It is a minimal shell on purpose: no rail, no catalog, nothing to click except the two
 * decisions, so an approval cannot be mistaken for browsing.
 */
export default async function ConnectPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { done } = await searchParams;
  const db = getDb();

  const request = await readAuthRequest(db, id);
  if (!request) notFound();

  const sessionToken = await readSessionCookie();
  const session = sessionToken ? await findSession(db, sessionToken) : null;

  // Only a pending request needs a login. Approved/denied/expired/consumed pages are terminal
  // receipts, and forcing a login to read one would lose the explanation for why it ended.
  if (request.status === "pending" && !session) {
    redirect(
      `/api/auth/sforum/start?redirect=${encodeURIComponent(`/connect/${id}`)}`,
    );
  }

  const issuerName = session
    ? ((await listActiveIssuers(db)).find(
        (issuer) => issuer.issuerKey === session.account.issuerKey,
      )?.displayName ?? session.account.issuerKey)
    : null;

  const shortCode = id.slice(0, 8).toUpperCase();
  const pluginLabel = request.clientLabel?.trim() || "一个 SForum 论坛";

  return (
    <main className="grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-6 flex items-center gap-2">
          <span className="eyebrow">SForum Store</span>
        </div>

        <div className="surface p-6">
          <h1 className="page-title">连接商城</h1>
          <p className="page-lede mt-2">
            {pluginLabel} 想把扩展安装请求发到本商城。允许之后，该论坛可以代表你获取下载链接。
          </p>

          {request.status === "pending" && session ? (
            <PendingDecision
              id={id}
              shortCode={shortCode}
              username={session.account.username ?? session.account.displayName ?? session.account.sub}
              issuerName={issuerName ?? session.account.issuerKey}
            />
          ) : (
            <TerminalState status={request.status} done={done ?? null} />
          )}
        </div>

        <p className="mt-4 text-[12.5px] text-muted-foreground">
          短码 {shortCode}：论坛插件页显示的应当是同一串。不一致时不要允许。
        </p>
      </div>
    </main>
  );
}

function PendingDecision({
  id,
  shortCode,
  username,
  issuerName,
}: {
  id: string;
  shortCode: string;
  username: string;
  issuerName: string;
}) {
  return (
    <>
      <dl className="mt-5 grid gap-2 text-[13px]">
        <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
          <dt className="text-muted-foreground">商城账号</dt>
          <dd className="font-medium">@{username}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
          <dt className="text-muted-foreground">来源论坛</dt>
          <dd className="font-medium">{issuerName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">请求短码</dt>
          <dd className="font-mono text-[12.5px]">{shortCode}</dd>
        </div>
      </dl>

      <p className="mt-4 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
        只在你刚在论坛插件页点过「连接商城」时允许。不是你自己发起的请求，请驳回。
      </p>

      <form action={`/api/connect/${id}/decision`} method="post" className="mt-5 flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="approve">
          允许
        </Button>
        <Button type="submit" name="decision" value="deny" variant="outline">
          驳回
        </Button>
      </form>

      <p className="mt-3 text-[12.5px] text-muted-foreground">
        要换账号？先在论坛退出登录，再回到插件页重新点「连接商城」。商城不在这里切换账号。
      </p>
    </>
  );
}

function TerminalState({
  status,
  done,
}: {
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  done: string | null;
}) {
  const copy = describeTerminal(status, done);
  return (
    <div className="mt-5">
      <p className="text-[13px] font-medium">{copy.title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{copy.body}</p>
    </div>
  );
}

function describeTerminal(
  status: "pending" | "approved" | "denied" | "consumed" | "expired",
  done: string | null,
): { title: string; body: string } {
  if (status === "pending") {
    // Pending without a session is unreachable (the page redirects), so this branch only
    // happens when a logged-out visitor lands on a receipt URL they already used.
    return {
      title: "这个请求还在等待批准",
      body: "回到论坛插件页重新点「连接商城」，或刷新本页重新登录。",
    };
  }
  if (status === "approved" || done === "approved") {
    return {
      title: "已允许，可以关闭此页",
      body: "回到论坛即可继续安装。插件会自动取走令牌，不需要你复制任何东西。",
    };
  }
  if (status === "consumed") {
    return {
      title: "这个请求已经用过了",
      body: "令牌已经交给发起请求的论坛。要重新连接，请在论坛插件页重新发起。",
    };
  }
  if (status === "denied" || done === "denied") {
    return {
      title: "已驳回",
      body: "没有任何令牌被签发。如果这是误操作，回到论坛插件页重新发起即可。",
    };
  }
  return {
    title: "这个请求已过期",
    body: "授权请求只有 5 分钟。回到论坛插件页重新点「连接商城」。",
  };
}

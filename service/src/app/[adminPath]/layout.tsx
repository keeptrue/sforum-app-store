import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getConfig } from "@/lib/config";

/**
 * The admin console lives on a top-level dynamic segment so `STORE_ADMIN_PATH` is read at
 * request time and a change only needs a restart, not a rebuild.
 *
 * This layout is the path gate: anything that is not the configured segment 404s before a
 * single byte of console chrome is rendered. Static routes (`/dashboard`, `/moderation`,
 * `/p/*`, `/api/*`) outrank a dynamic segment, so they are unaffected.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: { default: "管理员后台", template: "%s · 管理员后台" },
  robots: { index: false, follow: false },
};

export default async function AdminRootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ adminPath: string }>;
}) {
  const config = getConfig();
  const { adminPath } = await params;
  if (adminPath !== config.adminPath) notFound();
  return <>{children}</>;
}

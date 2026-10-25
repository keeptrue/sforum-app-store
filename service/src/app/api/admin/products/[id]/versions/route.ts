import { desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { releaseVersions } from "@/db/schema";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Versions of one product, newest first. The console only needs enough to pick a target for
 * a yank: version, channel, state, publish date.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const rows = await db
      .select({
        id: releaseVersions.id,
        version: releaseVersions.version,
        channel: releaseVersions.channel,
        state: releaseVersions.state,
        sforumVersionConstraint: releaseVersions.sforumVersionConstraint,
        publishedAt: releaseVersions.publishedAt,
        yankedAt: releaseVersions.yankedAt,
        yankReason: releaseVersions.yankReason,
        assetCount: sql<number>`(
          select count(*)::int from release_assets
          where release_assets.release_version_id = ${releaseVersions.id}
        )`,
      })
      .from(releaseVersions)
      .where(eq(releaseVersions.productId, id))
      .orderBy(desc(releaseVersions.publishedAt), desc(releaseVersions.version));

    return NextResponse.json({ versions: rows });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

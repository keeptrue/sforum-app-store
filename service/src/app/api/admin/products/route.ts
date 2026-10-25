import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { authorizeAdminRequest } from "@/lib/admin/guard";
import { adminErrorResponse } from "@/lib/admin/http";
import { listProductsForAdmin } from "@/lib/admin/products";
import type { ProductStatus } from "@/lib/products/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES: ProductStatus[] = [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "delisted",
];

export async function GET(request: Request) {
  try {
    const db = getDb();
    const auth = await authorizeAdminRequest(db, request, { mutation: false });
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status") ?? "all";
    const status =
      rawStatus !== "all" && STATUSES.includes(rawStatus as ProductStatus)
        ? (rawStatus as ProductStatus)
        : "all";

    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");

    const { rows, total } = await listProductsForAdmin(db, {
      q: url.searchParams.get("q") ?? undefined,
      status,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    return NextResponse.json({ products: rows, total });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

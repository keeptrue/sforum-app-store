import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";

import { ProductView } from "@/components/storefront/product-view";
import { getDb } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { findSession } from "@/lib/auth/service";
import { loadProductDetail, loadProductSocialImage } from "@/lib/catalog/query";
import {
  isReadmeStale,
  scheduleReadmeRefreshBySlug,
} from "@/lib/products/readme-cache";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { assetUrl } from "@/lib/storage/urls";

// Product visibility is a runtime fact (status, upstream connectivity, published
// versions), so this page is rendered per request and never prerendered.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The product's own title, and its link preview when the package ships
 * `brand/social-preview.png`.
 *
 * The image URL is absolute (crawlers do not resolve relative paths) and points at the
 * store's own content-addressed asset, so the card never advertises an upstream GitHub
 * address. A product without a card keeps its title and description and simply has no image —
 * no placeholder, no 404 image.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const db = getDb();
  // Metadata must never be the reason a product page fails: an unreadable settings row or a
  // missing asset just means "no card", and the page keeps the site defaults.
  const card = await loadProductSocialImage(db, slug).catch(() => null);
  if (!card) return {};

  const description = card.summary.trim() || undefined;
  const base: Metadata = {
    title: card.name,
    description,
    openGraph: { type: "website", title: card.name, description },
    twitter: { card: "summary_large_image", title: card.name, description },
  };
  if (!card.sha256 || card.width === null || card.height === null) return base;

  const publicUrl = await getRuntimeConfig(db)
    .then((runtime) => runtime.publicUrl)
    .catch(() => null);
  if (!publicUrl) return base;

  const url = new URL(assetUrl(card.sha256), publicUrl).toString();
  return {
    ...base,
    openGraph: {
      ...base.openGraph,
      images: [{ url, width: card.width, height: card.height, alt: card.name }],
    },
    twitter: { ...base.twitter, images: [url] },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = getDb();

  // A draft, a disconnected repo or a product without a published release all come
  // back as null, which is the same 404 an unknown slug gets.
  const product = await loadProductDetail(db, slug);
  if (!product) notFound();

  // The introduction follows the repository, but not at the cost of a visitor's latency:
  // a stale cache is refreshed after the response, and this request renders what we have.
  if (isReadmeStale(product.readme)) {
    after(() => scheduleReadmeRefreshBySlug(db, slug));
  }

  // The download gate is a runtime fact, so the button label has to be too: a visitor who is
  // not signed in sees "下载（需登录）" and the link still works — the route sends them through
  // the forum login and back to this exact file. In `anonymous` mode the flag is false and the
  // page renders exactly what it rendered before this feature existed.
  const runtime = await getRuntimeConfig(db);
  const sessionToken =
    runtime.downloadAuthMode === "account_required" ? await readSessionCookie() : null;
  const session = sessionToken ? await findSession(db, sessionToken) : null;

  return (
    <ProductView
      product={product}
      downloadGate={{
        required: runtime.downloadAuthMode === "account_required",
        signedIn: Boolean(session),
      }}
    />
  );
}

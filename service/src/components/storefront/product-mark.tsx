"use client";

/**
 * Product mark: the repository's GitHub social preview when the store has fetched one,
 * otherwise a letter tile. The image is never uploaded — the server pulls `og:image` from
 * the bound repository and stores it content-addressed — so this component only picks
 * between two states and never asks where the picture came from.
 *
 * One implementation for both the catalog card and the product header, so the fallback
 * tone and the alt-text decision cannot drift apart. The tile is a single quiet accent
 * tone — product kind is carried by the adjacent badge, not by tile color.
 *
 * `alt=""` on purpose: the product name is always rendered next to the mark, so the image
 * is decorative and repeating the name would only add noise for screen readers.
 */
export function ProductMark({
  name,
  kind,
  iconUrl,
  size = "sm",
}: {
  name: string;
  kind: "plugin" | "theme";
  iconUrl?: string | null;
  size?: "sm" | "lg";
}) {
  const px = size === "lg" ? 48 : 36;
  const box = size === "lg" ? "size-12 rounded-lg" : "size-9 rounded-md";

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={px}
        height={px}
        className={`shrink-0 ${box} border border-border object-cover`}
      />
    );
  }

  return (
    <div
      aria-hidden
      className={`grid shrink-0 place-items-center border border-accent-foreground/10 bg-accent font-semibold text-accent-foreground ${box} ${
        size === "lg" ? "text-base" : "text-sm"
      }`}
    >
      {name.trim().slice(0, 1) || "?"}
    </div>
  );
}

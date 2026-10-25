// Catalog taxonomy owned by the store (not SForum): a small, stable set of keys the
// dashboard picks from and the catalog filters on. Adding a key is a product decision,
// not a migration — `products.category` is plain text on purpose.
export const CATEGORY_KEYS = [
  "content",
  "appearance",
  "community",
  "integration",
  "ops",
  "security",
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  content: "内容",
  appearance: "外观主题",
  community: "社区功能",
  integration: "集成",
  ops: "运维",
  security: "安全",
};

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export function categoryLabel(key: string | null | undefined): string | null {
  return isCategoryKey(key) ? CATEGORY_LABELS[key] : null;
}

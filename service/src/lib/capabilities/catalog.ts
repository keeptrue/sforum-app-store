import catalogJson from "./catalog.json";
import lockJson from "./catalog.lock.json";

/**
 * Display-only view of the host capability catalog.
 *
 * `catalog.json` is a vendored copy of the table SForum generates from
 * `apps/api/app/Support/Capabilities/catalog.go` (see `scripts/sync-capability-catalog.ts`).
 * Nothing here decides whether a plugin is safe: the host's `risk` tier describes **what
 * host surface the capability reaches**, not the quality of the extension that declares it.
 * The store never invents a tier, and never raises one for a key it does not know.
 */

export type CapabilityRisk = "low" | "medium" | "high";

export type CapabilityEntry = {
  key: string;
  /** False when the host catalog this store vendored has no row for the key. */
  known: boolean;
  risk: CapabilityRisk | null;
  labelZh: string | null;
  labelEn: string | null;
  description: string | null;
};

type CatalogRow = {
  key: string;
  risk: CapabilityRisk;
  labelZh: string;
  labelEn: string;
  description: string;
};

const RISK_ORDER: Record<CapabilityRisk, number> = { high: 0, medium: 1, low: 2 };

export const CAPABILITY_RISK_LABELS: Record<CapabilityRisk, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/** Badge variants for the three host tiers; `warning` is the only middle tone we have. */
export const CAPABILITY_RISK_BADGE: Record<CapabilityRisk, "success" | "warning" | "destructive"> =
  {
    low: "success",
    medium: "warning",
    high: "destructive",
  };

const ROWS = (catalogJson as { entries: CatalogRow[] }).entries;
const BY_KEY = new Map<string, CatalogRow>(ROWS.map((row) => [row.key, row]));

export const CAPABILITY_CATALOG_PROVENANCE = {
  upstream: lockJson.upstream,
  source: lockJson.source,
  commit: lockJson.commit,
  commitShort: lockJson.commit.slice(0, 7),
  syncedAt: lockJson.syncedAt,
  entries: lockJson.entries,
} as const;

export function capabilityEntry(key: string): CapabilityEntry {
  const row = BY_KEY.get(key);
  if (!row) {
    return { key, known: false, risk: null, labelZh: null, labelEn: null, description: null };
  }
  return {
    key: row.key,
    known: true,
    risk: row.risk,
    labelZh: row.labelZh,
    labelEn: row.labelEn,
    description: row.description,
  };
}

/**
 * Describe a release's declared keys in the order the host's enable review uses: high
 * risk first, then medium, then low, with keys outside the vendored catalog last (they get
 * no tier at all — see the module comment). Duplicates collapse; the manifest parser already
 * sorts, but callers hand us DB arrays.
 */
export function describeCapabilities(keys: readonly string[]): CapabilityEntry[] {
  const seen = new Set<string>();
  const entries: CapabilityEntry[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(capabilityEntry(key));
  }
  return entries.sort((a, b) => {
    const rankA = a.risk ? RISK_ORDER[a.risk] : Number.POSITIVE_INFINITY;
    const rankB = b.risk ? RISK_ORDER[b.risk] : Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return a.key.localeCompare(b.key);
  });
}

export type CapabilitySummary = {
  total: number;
  known: number;
  unknown: number;
  byRisk: Record<CapabilityRisk, number>;
  /** Highest tier present; `null` when the release declares nothing (or only unknown keys). */
  maxRisk: CapabilityRisk | null;
};

export function summarizeCapabilities(entries: readonly CapabilityEntry[]): CapabilitySummary {
  const byRisk: Record<CapabilityRisk, number> = { low: 0, medium: 0, high: 0 };
  let unknown = 0;
  for (const entry of entries) {
    if (entry.risk) byRisk[entry.risk] += 1;
    else unknown += 1;
  }
  const maxRisk: CapabilityRisk | null =
    byRisk.high > 0 ? "high" : byRisk.medium > 0 ? "medium" : byRisk.low > 0 ? "low" : null;
  return {
    total: entries.length,
    known: entries.length - unknown,
    unknown,
    byRisk,
    maxRisk,
  };
}

/** Convenience for the two surfaces that render one release's capability set. */
export function capabilityBreakdown(keys: readonly string[]): {
  entries: CapabilityEntry[];
  summary: CapabilitySummary;
} {
  const entries = describeCapabilities(keys);
  return { entries, summary: summarizeCapabilities(entries) };
}

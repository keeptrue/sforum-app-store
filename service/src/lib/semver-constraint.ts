import semver from "semver";

/**
 * SForum manifests carry Masterminds-style semver constraints. node-semver understands
 * most of that grammar but not `!=`, and it only treats whitespace as the AND separator.
 * Both gaps matter: a constraint the store cannot parse makes the version invisible in the
 * catalog (`catalog/query.ts`), even though the host accepts the manifest.
 *
 * Parsing is therefore split from evaluation: each `||` group keeps its node-semver range
 * plus the `!=` comparators pulled out of it.
 */
export type ConstraintGroup = {
  /** node-semver range; `*` when the group only carried exclusions. */
  range: string;
  /** node-semver ranges that must NOT match, from `!=` comparators. */
  excluded: string[];
};

export type ParsedConstraint = {
  groups: ConstraintGroup[];
  /** Stable rendering for tests and logs; never shown as the manifest's raw text. */
  canonical: string;
};

/** Collapse `>= 1.0.0` to `>=1.0.0` so operator/version pairs survive tokenization. */
function tightenOperators(value: string): string {
  return value.replace(/([<>=!~^]+)\s+/g, "$1").replace(/\s+/g, " ").trim();
}

function parseGroup(raw: string): ConstraintGroup | null {
  const tokens = tightenOperators(raw).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  const comparators: string[] = [];
  const excluded: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("!=")) {
      const value = token.slice(2).trim();
      if (value.length === 0 || semver.validRange(value) === null) return null;
      excluded.push(value);
      continue;
    }
    comparators.push(token);
  }

  const range = comparators.length === 0 ? "*" : comparators.join(" ");
  if (semver.validRange(range) === null) return null;
  return { range, excluded };
}

/**
 * Returns null when the constraint is unusable. An unusable `sforumVersion` keeps the row
 * for moderation but hides it from public reads (plan §5.7), so callers must not guess.
 */
export function parseConstraint(
  raw: string | null | undefined,
): ParsedConstraint | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(/,/g, " ").trim();
  if (collapsed.length === 0) return null;

  const groups: ConstraintGroup[] = [];
  for (const part of collapsed.split("||")) {
    const group = parseGroup(part);
    if (group === null) return null;
    groups.push(group);
  }
  if (groups.length === 0) return null;

  const canonical = groups
    .map((group) => [group.range, ...group.excluded.map((item) => `!=${item}`)].join(" "))
    .join(" || ");
  return { groups, canonical };
}

export function constraintMatches(
  parsed: ParsedConstraint,
  version: string,
): boolean {
  const normalized = semver.valid(version);
  if (normalized === null) return false;
  for (const group of parsed.groups) {
    if (!semver.satisfies(normalized, group.range)) continue;
    if (group.excluded.some((range) => semver.satisfies(normalized, range))) continue;
    return true;
  }
  return false;
}

export function satisfiesConstraint(
  version: string | null | undefined,
  raw: string,
): boolean {
  if (typeof version !== "string") return false;
  const parsed = parseConstraint(raw);
  if (parsed === null) return false;
  return constraintMatches(parsed, version);
}

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
  /**
   * True when any comparator in this group names a prerelease. The host evaluates a
   * prerelease core against a whole OR-group with prereleases enabled whenever that group
   * mentions one, so the store has to reproduce the same switch (see `matchesGroup`).
   */
  mentionsPrerelease: boolean;
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

/** Does this node-semver range name a prerelease anywhere in its comparators? */
function mentionsPrerelease(range: string): boolean {
  return new semver.Range(range).set.some((set) =>
    set.some(
      (comparator) =>
        typeof comparator.semver === "object" && comparator.semver.prerelease.length > 0,
    ),
  );
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
  // A `!=` comparator that names a prerelease flips the group's mode just like a bound does.
  const prerelease = [range, ...excluded].some(mentionsPrerelease);
  return { range, excluded, mentionsPrerelease: prerelease };
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

/** `major.minor.patch` of a prerelease version; null when there is no prerelease. */
function releaseBase(version: string): string | null {
  const parsed = semver.parse(version);
  if (parsed === null || parsed.prerelease.length === 0) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function matchesGroup(group: ConstraintGroup, version: string): boolean {
  // node-semver drops a prerelease whose `major.minor.patch` tuple differs from every
  // prerelease comparator in the range; the host instead compares every comparator once the
  // group mentions a prerelease at all. `includePrerelease` is that switch, and the `!=`
  // exclusions ride the same mode so both halves of the group agree.
  const options = { includePrerelease: group.mentionsPrerelease };
  if (!semver.satisfies(version, group.range, options)) return false;
  if (group.excluded.some((range) => semver.satisfies(version, range, options))) return false;
  return true;
}

function matchesGroups(parsed: ParsedConstraint, version: string): boolean {
  return parsed.groups.some((group) => matchesGroup(group, version));
}

export function constraintMatches(
  parsed: ParsedConstraint,
  version: string,
): boolean {
  const normalized = semver.valid(version);
  if (normalized === null) return false;
  if (matchesGroups(parsed, normalized)) return true;
  // The host retries a prerelease core against its release baseline when the direct
  // evaluation fails (`CheckSForumVersion` -> `releaseBase`), so `3.0.13-alpha.2` still
  // matches `>=3.0.12`. Without the retry the store hides packages core would install.
  const base = releaseBase(normalized);
  return base !== null && matchesGroups(parsed, base);
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

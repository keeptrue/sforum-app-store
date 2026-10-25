/**
 * Which `push` deliveries are worth a brand refresh.
 *
 * The store subscribes to `push` only to notice `brand/` edits. That event is by far the
 * noisiest one GitHub sends — every branch, every force push, every repository the App can
 * see — so the decision is made in the webhook route *before* the delivery is stored, and
 * again before any work starts. Cheap to compute, and it keeps `webhook_deliveries` from
 * filling up with payloads nobody will ever read.
 *
 * The path test is `(^|/)brand/` on purpose: an extension package may live in a subdirectory
 * (`plugins/sforum-oauth2-provider/brand/icon.png`), which is exactly how the reference
 * plugin repository lays it out.
 */

const BRAND_PATH = /(?:^|\/)brand\//;

type CommitLike = {
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
};

export type PushPayload = {
  ref?: unknown;
  deleted?: unknown;
  size?: unknown;
  commits?: unknown;
  head_commit?: unknown;
  repository?: { id?: unknown; default_branch?: unknown } | null;
};

function pathsOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const commit = value as CommitLike;
  const out: string[] = [];
  for (const key of ["added", "modified", "removed"] as const) {
    const list = commit[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string") out.push(entry);
    }
  }
  return out;
}

/**
 * True when this push moved the default branch and touched a `brand/` path.
 *
 * A truncated commit list, a branch creation or a force push with no file list all count as
 * "touched": the refresh compares the blob sha first, so a false positive costs one API call
 * and downloads nothing.
 */
export function pushTouchesBrand(payload: PushPayload): boolean {
  if (payload.deleted === true) return false;

  const defaultBranch = payload.repository?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) return false;
  if (payload.ref !== `refs/heads/${defaultBranch}`) return false;

  const commits = Array.isArray(payload.commits)
    ? payload.commits.filter((entry): entry is CommitLike => typeof entry === "object" && entry !== null)
    : [];

  const size = typeof payload.size === "number" ? payload.size : commits.length;
  if (size > commits.length) return true;
  if (commits.length === 0) return true;

  const candidates: unknown[] = [...commits];
  if (payload.head_commit) candidates.push(payload.head_commit);
  return candidates.some((commit) =>
    pathsOf(commit).some((path) => BRAND_PATH.test(path)),
  );
}

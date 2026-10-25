import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "@/db/client";
import {
  githubRepos,
  products,
  releaseVersions,
  repoReleases,
} from "@/db/schema";
import type { GithubConfig } from "@/lib/config";
import { loadGithubConfig } from "./app-config";
import { GithubAppClient, type GithubWorkflowRun } from "./client";

/**
 * The review console's GitHub Actions hint (plan §7.4 item 25).
 *
 * Scope is deliberately narrow, because `Actions: read` is the widest permission the App
 * asks for beyond `Contents: read` (AGENTS.md "GitHub App"):
 *
 * 1. it only *shows* the conclusion of the workflow runs that point at the commit a release
 *    points at;
 * 2. it never feeds a decision — the approve/reject service does not import this module;
 * 3. it downloads nothing and toggles nothing, so it is not a release gate.
 *
 * Unconfigured App, missing repo binding, 401/403/404, timeout, network error, unexpected
 * payload shape: every one of those resolves to `null`. The console then renders nothing,
 * which is the contract — the hint is optional, and a broken upstream must never break the
 * page or make it look like a submission was rejected.
 */

/** Whole-operation budget. Two sequential calls share it; the console caps at 3s (item 25). */
const DEFAULT_TIMEOUT_MS = 2_500;

/** States a moderator is currently deciding on: a first review or a re-review. */
const REVIEWABLE_STATES = ["candidate", "pending_review"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkflowRunVerdict = "success" | "failure" | "pending" | "neutral";

export type WorkflowRunSummary = {
  id: number;
  name: string;
  url: string;
  status: string;
  conclusion: string | null;
};

/** What the console renders. Built only from GitHub data plus the release row it matched. */
export type ReviewWorkflowHint = {
  verdict: WorkflowRunVerdict;
  /** Release tag the reviewed version was synced from. */
  tag: string;
  /** Manifest version of the version under review. */
  version: string;
  commitSha: string;
  /** How many runs exist for that commit; the link below points at one of them. */
  runCount: number;
  run: WorkflowRunSummary;
};

/** The slice of `GithubAppClient` this module needs — a fake satisfies it in tests. */
export type WorkflowRunsClient = {
  getCommitSha(
    repoFullName: string,
    ref: string,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<string>;
  listWorkflowRunsForCommit(
    repoFullName: string,
    commitSha: string,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<GithubWorkflowRun[]>;
};

/** The release a review is actually about, resolved from the database. */
export type ReviewReleaseTarget = {
  version: string;
  tag: string;
  repoFullName: string;
  installationId: number;
};

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "action_required",
]);

/** Worst-first, so one red run cannot be hidden by a green one on the same commit. */
const SEVERITY: Record<WorkflowRunVerdict, number> = {
  success: 0,
  neutral: 1,
  pending: 2,
  failure: 3,
};

/**
 * `status` is the lifecycle ("queued" / "in_progress" / "completed"); `conclusion` is only
 * meaningful once the run completed. A run that is still going is reported as pending, not
 * as a pass.
 */
export function verdictOf(run: {
  status?: unknown;
  conclusion?: unknown;
}): WorkflowRunVerdict {
  const status = typeof run.status === "string" ? run.status : "";
  const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  if (conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)) return "failure";
  // cancelled / skipped / neutral / stale / a missing conclusion.
  return "neutral";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

type ParsedRun = WorkflowRunSummary & {
  verdict: WorkflowRunVerdict;
  startedAt: number;
};

/**
 * Validate one entry of `workflow_runs`. Anything that cannot be rendered (no id, no usable
 * `html_url`, a run for a different commit) is dropped instead of guessed at.
 */
function parseRun(value: unknown, commitSha: string): ParsedRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.id !== "number" || !Number.isFinite(run.id)) return null;
  if (typeof run.html_url !== "string" || !isHttpUrl(run.html_url)) return null;
  // `head_sha` is filtered server-side, so a mismatch means the payload is not what we asked
  // for; dropping it is cheaper than explaining a run from another commit.
  if (typeof run.head_sha === "string" && run.head_sha !== commitSha) return null;

  const started = Date.parse(
    typeof run.run_started_at === "string"
      ? run.run_started_at
      : typeof run.created_at === "string"
        ? run.created_at
        : "",
  );
  const name = typeof run.name === "string" && run.name.trim() ? run.name.trim() : "workflow";

  return {
    id: run.id,
    name,
    url: run.html_url,
    status: typeof run.status === "string" ? run.status : "",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    verdict: verdictOf(run),
    startedAt: Number.isFinite(started) ? started : 0,
  };
}

/**
 * Collapse the runs of one commit into the single line the console shows.
 *
 * The verdict is the worst run on that commit (a commit is only as green as its weakest
 * workflow), while the link points at the run that produced that verdict — so the reviewer
 * lands on the failure rather than on a passing lint job. Newest run wins a tie.
 */
export function interpretWorkflowRuns(
  runs: readonly unknown[],
  commitSha: string,
): { verdict: WorkflowRunVerdict; runCount: number; run: WorkflowRunSummary } | null {
  const parsed = runs
    .map((run) => parseRun(run, commitSha))
    .filter((run): run is ParsedRun => run !== null);
  if (parsed.length === 0) return null;

  parsed.sort((left, right) => right.startedAt - left.startedAt || right.id - left.id);

  const verdict = parsed.reduce<WorkflowRunVerdict>(
    (worst, run) => (SEVERITY[run.verdict] > SEVERITY[worst] ? run.verdict : worst),
    "success",
  );
  const decisive = parsed.find((run) => run.verdict === verdict) ?? parsed[0]!;

  return {
    verdict,
    runCount: parsed.length,
    run: {
      id: decisive.id,
      name: decisive.name,
      url: decisive.url,
      status: decisive.status,
      conclusion: decisive.conclusion,
    },
  };
}

/**
 * Resolve a timeout to `null` without waiting for the underlying promise. `fetch` may ignore
 * its signal, and the console must not hang on a socket that never answers.
 */
function withTimeout<T>(work: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Ask GitHub about the commit of one release. Never rejects: every failure is `null`.
 *
 * `AbortSignal.timeout` cancels the sockets (and the second call inherits whatever budget is
 * left), `withTimeout` bounds the whole operation even if a fetch ignores the signal.
 */
export async function fetchReviewWorkflowHint(
  client: WorkflowRunsClient,
  target: ReviewReleaseTarget,
  options: { timeoutMs?: number } = {},
): Promise<ReviewWorkflowHint | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  const work = (async (): Promise<ReviewWorkflowHint | null> => {
    const commitSha = await client.getCommitSha(
      target.repoFullName,
      target.tag,
      target.installationId,
      signal,
    );
    if (!commitSha) return null;
    const runs = await client.listWorkflowRunsForCommit(
      target.repoFullName,
      commitSha,
      target.installationId,
      signal,
    );
    const note = interpretWorkflowRuns(runs, commitSha);
    if (!note) return null;
    return {
      ...note,
      tag: target.tag,
      version: target.version,
      commitSha,
    };
  })().catch(() => null);

  return withTimeout(work, timeoutMs);
}

/**
 * The release behind the version a moderator is looking at.
 *
 * `versionId` is the version the console focused (URL parameter, otherwise the first held
 * one); with no match the newest reviewable release wins. A product with no bound repo has
 * no installation to ask, so it never reaches GitHub.
 */
export async function loadReviewReleaseTarget(
  db: Db,
  input: { productId: string; versionId: string | null },
): Promise<ReviewReleaseTarget | null> {
  if (!UUID_PATTERN.test(input.productId)) return null;

  const rows = await db
    .select({
      versionId: releaseVersions.id,
      version: releaseVersions.version,
      tag: repoReleases.tag,
      repoFullName: githubRepos.fullName,
      installationId: githubRepos.installationId,
    })
    .from(releaseVersions)
    .innerJoin(repoReleases, eq(repoReleases.id, releaseVersions.repoReleaseId))
    .innerJoin(products, eq(products.id, releaseVersions.productId))
    // The join is the "we can actually ask GitHub" test: an installation must know the repo.
    .innerJoin(githubRepos, eq(githubRepos.repoId, repoReleases.repoId))
    .where(
      and(
        eq(releaseVersions.productId, input.productId),
        isNotNull(products.repoId),
        inArray(releaseVersions.state, [...REVIEWABLE_STATES]),
      ),
    )
    .orderBy(desc(releaseVersions.createdAt), desc(releaseVersions.id));

  if (rows.length === 0) return null;
  const row = rows.find((candidate) => candidate.versionId === input.versionId) ?? rows[0]!;
  return {
    version: row.version,
    tag: row.tag,
    repoFullName: row.repoFullName,
    installationId: row.installationId,
  };
}

// One client per config object, so installation tokens survive between page views instead of
// being minted for every render (same rationale as `lib/download/upstream.ts`).
let cachedClient: { config: GithubConfig; client: GithubAppClient } | null = null;

async function configuredClient(db: Db): Promise<GithubAppClient | null> {
  let github: GithubConfig | null;
  try {
    // Console-configured, so this is a database read (cached); a broken row must not reach
    // the review console either — the hint simply disappears.
    github = await loadGithubConfig(db);
  } catch {
    return null;
  }
  if (!github) return null;
  if (cachedClient?.config !== github) {
    cachedClient = { config: github, client: new GithubAppClient(github) };
  }
  return cachedClient.client;
}

export type ReviewWorkflowHintInput = {
  productId: string;
  /** `products.repo_id`: null means no repository is bound, so there is nothing to ask. */
  repoId: number | null;
  /** The version the console focused, if any. */
  versionId: string | null;
};

/**
 * Console entry point. Returns `null` — never throws — when the App is unconfigured, the
 * product has no bound repo, the release is unknown, GitHub answers an error, the call times
 * out, or the payload does not look like `workflow_runs`.
 *
 * `deps.client` exists for tests only: pass `null` to mean "GitHub App not configured", or a
 * fake to keep the suite offline. Omitting it reads the real config.
 */
export async function loadReviewWorkflowHint(
  db: Db,
  input: ReviewWorkflowHintInput,
  deps: { client?: WorkflowRunsClient | null; timeoutMs?: number } = {},
): Promise<ReviewWorkflowHint | null> {
  try {
    if (input.repoId === null) return null;
    const client =
      deps.client === undefined ? await configuredClient(db) : deps.client;
    if (!client) return null;
    const target = await loadReviewReleaseTarget(db, input);
    if (!target) return null;
    return await fetchReviewWorkflowHint(client, target, { timeoutMs: deps.timeoutMs });
  } catch {
    return null;
  }
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { FormError } from "@/components/common/field";
import { Modal } from "@/components/common/modal";import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { jsonRequest, requestJson } from "@/components/dashboard/api";
import { UPSTREAM_STATE_LABELS, UPSTREAM_STATE_TONES } from "@/components/dashboard/labels";
import { messageFor } from "@/components/dashboard/messages";
import type { InstallationSummary, SelectableRepo } from "@/lib/github/repos";

/**
 * The repository picker.
 *
 * Two facts drive the whole component: the list is *local* (mirrored `github_repos` rows,
 * never a live GitHub call on open), and it only ever contains repositories behind one of
 * the account's own `active` installations. "从 GitHub 同步" is the explicit way to refresh
 * it — nothing is fetched behind the developer's back.
 */
export function RepoPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  failure: externalFailure,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  /** Failure raised by the caller's own submit (binding, import), rendered in place. */
  failure?: string | null;
  onPick: (repoId: number) => void;
}) {
  const [repos, setRepos] = useState<SelectableRepo[]>([]);
  const [installations, setInstallations] = useState<InstallationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    const [repoResult, installationResult] = await Promise.all([
      requestJson<{ repos: SelectableRepo[] }>("/api/dashboard/github/repos"),
      requestJson<{ installations: InstallationSummary[] }>(
        "/api/dashboard/github/installations",
      ),
    ]);
    setLoading(false);
    if (!repoResult.ok) {
      setFailure(messageFor(repoResult.failure));
      return;
    }
    setRepos(repoResult.data.repos);
    setInstallations(
      installationResult.ok ? installationResult.data.installations : [],
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setQuery("");
    void load();
  }, [open, load]);

  const activeInstallations = useMemo(
    () => installations.filter((row) => row.status === "active"),
    [installations],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [repos, query]);

  async function syncFromGithub() {
    setSyncing(true);
    setFailure(null);
    let total = 0;
    for (const installation of activeInstallations) {
      const result = await jsonRequest<{ repositories: number }>(
        "/api/dashboard/github/repos/refresh",
        "POST",
        { installationId: installation.installationId },
      );
      if (!result.ok) {
        setSyncing(false);
        setFailure(messageFor(result.failure));
        return;
      }
      total += result.data.repositories;
    }
    setSyncing(false);
    toast.success("仓库列表已同步", { description: `共 ${total} 个仓库可见。` });
    await load();
  }

  const selectedRepo = repos.find((repo) => repo.repoId === selected) ?? null;
  const blocked = selectedRepo ? selectedRepo.archived : true;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <span className="mr-auto hidden text-[12.5px] text-muted-foreground sm:inline">
            {repos.length > 0 ? `${repos.length} 个可选仓库` : "还没有可选仓库"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={selected === null || blocked || pending}
            onClick={() => {
              if (selected !== null) onPick(selected);
            }}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按仓库名筛选"
              className="pl-8"
              autoComplete="off"
              spellCheck={false}
              aria-label="按仓库名筛选"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={syncing || activeInstallations.length === 0}
            onClick={() => void syncFromGithub()}
          >
            {syncing ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw aria-hidden />
            )}
            从 GitHub 同步
          </Button>
        </div>

        {failure ?? externalFailure ? (
          <FormError>{failure ?? externalFailure}</FormError>
        ) : null}

        {loading ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            正在读取仓库列表…
          </p>
        ) : activeInstallations.length === 0 ? (
          <div className="surface-dashed px-4 py-6 text-center">
            <p className="text-xs font-medium">还没有连接 GitHub</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted-foreground">
              商城通过 GitHub App 只读仓库内容，不保存任何个人访问令牌。先安装 App 并授予要发布的
              仓库，再回来选择。
            </p>
            <Button asChild size="sm" variant="outline" className="mt-3">
              <a href="/api/github/install/start">
                <GitBranch aria-hidden />
                连接 GitHub
              </a>
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="surface-dashed px-4 py-6 text-center">
            <p className="text-xs font-medium">
              {repos.length === 0 ? "本地还没有仓库记录" : "没有匹配的仓库"}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {repos.length === 0
                ? "点「从 GitHub 同步」把 App 可见的仓库拉到本地。"
                : "换个关键词，或清空筛选。"}
            </p>
          </div>
        ) : (
          <ul className="grid max-h-[46vh] gap-1 overflow-y-auto pr-0.5">
            {visible.map((repo) => {
              const disabled = repo.archived;
              const active = repo.repoId === selected;
              return (
                <li key={repo.repoId}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => setSelected(repo.repoId)}
                    className={[
                      "flex w-full items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-left transition-colors",
                      active
                        ? "border-primary/60 bg-primary/5"
                        : "border-border hover:bg-muted/50",
                      disabled ? "cursor-not-allowed opacity-60" : "",
                    ].join(" ")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">
                        {repo.fullName}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        {repo.private ? (
                          <Badge variant="outline">私有</Badge>
                        ) : null}
                        {repo.archived ? (
                          <Badge variant="muted">已归档</Badge>
                        ) : null}
                        <Badge variant={UPSTREAM_STATE_TONES[repo.upstreamState]}>
                          {UPSTREAM_STATE_LABELS[repo.upstreamState]}
                        </Badge>
                        {repo.defaultBranch ? (
                          <span className="font-mono text-[12px] text-muted-foreground">
                            {repo.defaultBranch}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

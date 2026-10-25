"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AdminProductRow } from "@/lib/admin/products";
import { jsonRequest, requestJson } from "@/lib/http-client";

type VersionRow = {
  id: string;
  version: string;
  channel: string;
  state: string;
  sforumVersionConstraint: string;
  publishedAt: string | null;
  yankedAt: string | null;
  yankReason: string | null;
  assetCount: number;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_review: "待审",
  published: "已发布",
  rejected: "已拒绝",
  delisted: "已下架",
};

function formatTime(value: Date | string | null): string {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso.replace("T", " ").slice(0, 16);
}

/**
 * Cross-owner product list. The two write actions here are the ones an operator needs during
 * an incident: take a product off the catalog, or pull one bad version.
 */
export function AdminProductsTable({
  initialRows,
  initialTotal,
}: {
  initialRows: AdminProductRow[];
  initialTotal: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [searching, setSearching] = useState(false);

  const [versionTarget, setVersionTarget] = useState<AdminProductRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [yankTarget, setYankTarget] = useState<VersionRow | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true);
    const result = await requestJson<{ products: AdminProductRow[]; total: number }>(
      `/api/admin/products?q=${encodeURIComponent(query.trim())}&status=${status}`,
    );
    setSearching(false);
    if (!result.ok) {
      toast.error(result.failure.message || "查询失败");
      return;
    }
    setRows(result.data.products);
    setTotal(result.data.total);
  }

  async function openVersions(product: AdminProductRow) {
    setVersionTarget(product);
    setVersions(null);
    setVersionsError(null);
    const result = await requestJson<{ versions: VersionRow[] }>(
      `/api/admin/products/${product.id}/versions`,
    );
    if (!result.ok) {
      setVersionsError(result.failure.message || "读取版本失败");
      return;
    }
    setVersions(result.data.versions);
  }

  async function delistProduct(product: AdminProductRow) {
    const input = window.prompt(
      `下架「${product.name}」。填写原因（会写进审计）：`,
      "运营下架",
    );
    if (input === null) return;

    setBusy(true);
    const result = await jsonRequest(`/api/admin/products/${product.id}/delist`, "POST", {
      reason: input.trim() || "运营下架",
    });
    setBusy(false);

    if (!result.ok) {
      toast.error(result.failure.message || "下架失败");
      return;
    }
    toast.success("已下架");
    router.refresh();
  }

  async function submitYank(event: React.FormEvent) {
    event.preventDefault();
    if (!yankTarget) return;

    setBusy(true);
    const result = await jsonRequest(`/api/admin/versions/${yankTarget.id}/yank`, "POST", {
      reason: reason.trim(),
    });
    setBusy(false);

    if (!result.ok) {
      toast.error(result.failure.message || "撤回失败");
      return;
    }
    toast.success(`版本 ${yankTarget.version} 已撤回`);
    setYankTarget(null);
    setReason("");
    if (versionTarget) await openVersions(versionTarget);
    router.refresh();
  }

  return (
    <>
      <form onSubmit={search} className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称、短链或扩展 ID 搜索"
          aria-label="搜索产品"
          className="max-w-xs"
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="按状态筛选"
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="all">全部状态</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" size="sm" disabled={searching}>
          {searching ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Search className="size-4" aria-hidden />
          )}
          筛选
        </Button>
        <span className="text-xs text-muted-foreground">共 {total} 个</span>
      </form>

      <div className="overflow-x-auto surface">
        <table className="w-full text-sm">
          <caption className="sr-only">全站产品</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">产品</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">归属</th>
              <th scope="col" className="px-3 py-2 font-medium">状态</th>
              <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">版本</th>
              <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">更新</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  没有匹配的产品
                </td>
              </tr>
            ) : (
              rows.map((product) => (
                <tr key={product.id}>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{product.name}</span>
                    <span className="ml-2 font-mono text-[12.5px] text-muted-foreground">
                      {product.extensionId}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">
                    {product.ownerName ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[12.5px]">
                      {STATUS_LABEL[product.status] ?? product.status}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-xs md:table-cell">
                    {product.versionCount}
                    <span className="ml-1 text-muted-foreground">
                      （发布 {product.publishedVersions} / 待审 {product.pendingVersions}）
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground lg:table-cell">
                    {formatTime(product.updatedAt)}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openVersions(product)}
                      >
                        版本
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={busy || product.status !== "published"}
                        onClick={() => delistProduct(product)}
                      >
                        <Ban className="size-3.5" aria-hidden />
                        强制下架
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={versionTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setVersionTarget(null);
            setVersions(null);
            setVersionsError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>版本 · {versionTarget?.name}</DialogTitle>
            <DialogDescription>
              撤回已发布的版本会立即让旧下载链接失效；产品的最新版本会重新计算。
            </DialogDescription>
          </DialogHeader>

          {versionsError ? (
            <p role="alert" className="text-sm text-destructive">{versionsError}</p>
          ) : versions === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">读取中…</p>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">这个产品还没有版本</p>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">版本</th>
                    <th scope="col" className="px-3 py-2 font-medium">渠道</th>
                    <th scope="col" className="px-3 py-2 font-medium">状态</th>
                    <th scope="col" className="px-3 py-2 font-medium">发布时间</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {versions.map((version) => (
                    <tr key={version.id}>
                      <td className="px-3 py-2 font-mono text-xs">{version.version}</td>
                      <td className="px-3 py-2 text-xs">{version.channel}</td>
                      <td className="px-3 py-2 text-xs">{version.state}</td>
                      <td className="px-3 py-2 font-mono text-[12.5px] text-muted-foreground">
                        {formatTime(version.publishedAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={version.state !== "published"}
                          onClick={() => {
                            setYankTarget(version);
                            setReason("");
                          }}
                        >
                          撤回
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">关闭</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={yankTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setYankTarget(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤回版本 {yankTarget?.version}</DialogTitle>
            <DialogDescription>
              填写原因，会写进审计与版本记录。撤回后该版本的签名下载链接立即失效。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitYank} className="space-y-3">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：二进制含未声明的能力"
              aria-label="撤回原因"
              required
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost">取消</Button>
              </DialogClose>
              <Button type="submit" disabled={busy || reason.trim().length === 0}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                确认撤回
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

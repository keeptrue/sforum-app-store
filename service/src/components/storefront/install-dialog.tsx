"use client";

import { useMemo, useState } from "react";
import { Copy, Download, ShieldCheck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyDigest } from "@/components/storefront/clipboard";
import { useInstallDialog } from "@/components/storefront/install-store";

/**
 * Presentational only: every value comes from the target the caller put in the store
 * (page data). No product lookup, no seed data, no placeholder digest.
 */
export function InstallDialog() {
  const target = useInstallDialog((state) => state.target);
  const close = useInstallDialog((state) => state.close);
  const [platformKey, setPlatformKey] = useState<string | null>(null);

  const platform = useMemo(() => {
    if (!target) return null;
    return (
      target.platforms.find((item) => `${item.os}/${item.arch}` === platformKey) ??
      target.platforms[0] ??
      null
    );
  }, [target, platformKey]);

  const open = Boolean(target);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPlatformKey(null);
          close();
        }
      }}
    >
      <DialogContent className="max-h-[calc(var(--viewport-h)-2rem)] max-w-[440px] overflow-y-auto rounded-panel border-border bg-card p-0">
        <DialogHeader className="flex-row items-center gap-3 border-b border-border px-5 py-4">
          <span
            className="plate-surface grid size-[44px] shrink-0 place-items-center rounded-[14px] text-lg font-semibold"
            style={{ color: "var(--plate-ink)" }}
            aria-hidden
          >
            {target?.name.trim().slice(0, 1) || "?"}
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[18px] font-semibold tracking-[-.01em]">
              获取安装包
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate font-mono text-[12px]">
              {target ? `${target.name} · v${target.version}` : ""}
              {platform ? ` · ${platform.os}/${platform.arch}` : ""}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="space-y-3.5 px-5 py-4">
          {target && target.platforms.length > 1 && (
            <fieldset>
              <legend className="text-[12.5px] text-muted-foreground">平台</legend>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                {target.platforms.map((item) => {
                  const key = `${item.os}/${item.arch}`;
                  const checked = platform
                    ? key === `${platform.os}/${platform.arch}`
                    : false;
                  return (
                    <label
                      key={key}
                      className={`flex cursor-pointer items-center gap-2 rounded-[9px] border px-2 py-1.5 font-mono text-[12px] transition-colors ${
                        checked
                          ? "border-foreground/25 bg-accent text-foreground"
                          : "border-transparent text-muted-foreground hover:bg-accent/60"
                      }`}
                    >
                      <input
                        type="radio"
                        name="install-platform"
                        value={key}
                        checked={checked}
                        onChange={() => setPlatformKey(key)}
                        className="size-3 accent-[var(--primary)]"
                      />
                      {key}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1.5 rounded-cup border border-border bg-evidence px-3 py-2.5 text-[12.5px]">
            <span className="text-muted-foreground">资产</span>
            <span className="break-all font-mono text-[12px]">
              {platform?.filename ?? "—"}
            </span>
            <span className="text-muted-foreground">大小</span>
            <span className="font-mono text-[12px] tabular-nums">
              {formatBytes(platform?.size)}
            </span>
            <span className="pt-0.5 text-muted-foreground">SHA-256</span>
            {platform?.sha256 ? (
              <button
                type="button"
                className="group flex items-start gap-1.5 text-left"
                onClick={() => copyDigest(platform.sha256!)}
                aria-label="复制 SHA-256 摘要"
              >
                <span className="break-all font-mono text-[12px] leading-relaxed text-muted-foreground group-hover:text-foreground">
                  {platform.sha256}
                </span>
                <Copy
                  className="mt-0.5 size-3 shrink-0 text-muted-foreground group-hover:text-foreground"
                  aria-hidden
                />
              </button>
            ) : (
              <span className="font-mono text-[12px] text-muted-foreground">—</span>
            )}
          </div>

          <ol className="grid gap-2">
            {[
              ["01", "取签名链接", "302 到签名地址，30 分钟内有效"],
              ["02", "论坛取包", "安装期间不要关闭页面"],
              ["03", "暂存待信任", "启用与信任在论坛后台"],
            ].map(([num, title, note]) => (
              <li key={num} className="grid grid-cols-[20px_1fr] gap-2.5 text-[12.5px]">
                <span className="grid size-5 place-items-center rounded-full border border-foreground/20 bg-accent font-mono text-[12px] leading-none">
                  {num}
                </span>
                <span>
                  <span className="text-foreground/85">{title}</span>
                  <span className="block text-[12px] leading-relaxed text-muted-foreground">
                    {note}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
            链接 30 分钟内有效，可重复取用；安装只到暂存，启用与信任在论坛后台完成。
          </p>
        </div>

        <DialogFooter className="border-t border-border bg-evidence px-5 py-3">
          <button
            type="button"
            onClick={close}
            className="press inline-flex h-9 items-center justify-center rounded-[10px] px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          {target && platform ? (
            <a
              href={`/api/v1/products/${target.slug}/download/${platform.os}/${platform.arch}`}
              download
              className="press inline-flex h-9 items-center justify-center gap-1.5 rounded-[11px] bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.25)]"
            >
              <Download className="size-3.5" aria-hidden />
              下载安装包
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[11px] bg-primary px-3.5 text-xs font-semibold text-primary-foreground opacity-40"
            >
              <Download className="size-3.5" aria-hidden />
              下载安装包
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

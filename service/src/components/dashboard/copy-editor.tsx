"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TagsField } from "@/components/dashboard/tags-field";
import { jsonRequest } from "@/components/dashboard/api";
import { messageFor } from "@/components/dashboard/messages";
import type { DashboardProductDetail } from "@/lib/products/types";
import { CATEGORY_KEYS, CATEGORY_LABELS, isCategoryKey } from "@/lib/products/taxonomy";

const SUMMARY_MAX = 300;

/**
 * The three fields a developer still owns. The name comes from the extension manifest and
 * the introduction from the repository README, so neither is a text box here.
 */
type Draft = {
  summary: string;
  category: string;
  tags: string[];
};

function draftOf(product: DashboardProductDetail): Draft {
  return {
    summary: product.summary,
    // A category that is no longer in the taxonomy (or was written outside this UI) must not
    // survive as a hidden value: the select would show nothing and PATCH would answer 400.
    category: isCategoryKey(product.category) ? product.category : "",
    tags: product.tags,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.summary === b.summary &&
    a.category === b.category &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/**
 * Copy editor for the product's default locale.
 *
 * `PATCH /api/dashboard/products/{id}` is the only writer. The response is adopted as the new
 * baseline because the server trims whitespace and strips HTML — showing what was typed would
 * hide exactly the difference that matters before submitting for review.
 *
 * "从 README 生成" is a read-only suggestion: it fills the textarea and stops there, so the
 * summary stays a sentence a person accepted rather than a value the machine wrote.
 */
export function CopyEditor({ product }: { product: DashboardProductDetail }) {
  const router = useRouter();
  const [saved, setSaved] = useState<Draft>(() => draftOf(product));
  const [draft, setDraft] = useState<Draft>(() => draftOf(product));
  const [pending, setPending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = !sameDraft(draft, saved);
  const update = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    setPending(true);
    setError(null);
    const result = await jsonRequest<{ product: DashboardProductDetail }>(
      `/api/dashboard/products/${product.id}`,
      "PATCH",
      {
        summary: draft.summary,
        category: draft.category === "" ? null : draft.category,
        tags: draft.tags,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(messageFor(result.failure));
      return;
    }
    const next = draftOf(result.data.product);
    setSaved(next);
    setDraft(next);
    toast.success("文案已保存");
    router.refresh();
  }

  async function suggestSummary() {
    setSuggesting(true);
    setError(null);
    const result = await jsonRequest<{ summary: string }>(
      `/api/dashboard/products/${product.id}/summary-suggestion`,
      "POST",
    );
    setSuggesting(false);
    if (!result.ok) {
      setError(messageFor(result.failure));
      return;
    }
    if (!result.data.summary.trim()) {
      setError("README 里没有找到可用的段落，手动写一句更准确。");
      return;
    }
    // Filled, not saved: the textarea is still the developer's decision.
    update({ summary: result.data.summary });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>文案</CardTitle>
          <span className="font-mono text-[12.5px] text-muted-foreground">
            默认语言 {product.defaultLocale}
          </span>
        </div>
        <CardDescription>
          名称与介绍来自仓库：名称取自扩展清单，介绍取自 README。这里只维护摘要、分类与标签。
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="product-summary" className="text-xs font-medium">
                摘要
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] tabular-nums text-muted-foreground">
                  {draft.summary.length}/{SUMMARY_MAX}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={suggesting || product.repoId === null}
                  onClick={() => void suggestSummary()}
                >
                  {suggesting ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Sparkles aria-hidden />
                  )}
                  从 README 生成
                </Button>
              </div>
            </div>
            <Textarea
              id="product-summary"
              value={draft.summary}
              maxLength={SUMMARY_MAX}
              rows={3}
              onChange={(event) => update({ summary: event.target.value })}
              aria-describedby="product-summary-hint"
            />
            <p id="product-summary-hint" className="text-[12.5px] text-muted-foreground">
              摘要为空会被提交审核拒绝（<span className="font-mono">missing_copy</span>）。
              「从 README 生成」只是把候选句填进输入框，保存仍由你确认。
              {product.repoId === null ? "产品还没绑定仓库，暂时不能生成。" : ""}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="product-category" className="text-xs font-medium">
              分类
            </label>
            <Select
              id="product-category"
              value={draft.category}
              onChange={(event) => update({ category: event.target.value })}
            >
              <option value="">暂不指定</option>
              {CATEGORY_KEYS.map((key) => (
                <option key={key} value={key}>
                  {CATEGORY_LABELS[key]}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium">标签</span>
            <TagsField
              id="product-tags"
              value={draft.tags}
              onChange={(tags) => update({ tags })}
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[13px] leading-relaxed text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button type="submit" size="sm" disabled={pending || !dirty}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              保存文案
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending || !dirty}
              onClick={() => {
                setDraft(saved);
                setError(null);
              }}
            >
              <Undo2 aria-hidden />
              撤销修改
            </Button>
            <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
              {dirty ? "有未保存的修改" : "已与服务器一致"}
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

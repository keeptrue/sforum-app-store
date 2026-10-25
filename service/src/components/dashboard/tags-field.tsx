"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;

/**
 * Chips + a free-text field. The API trims and de-duplicates tags, but it cannot guess where
 * one tag ends: splitting on comma / ideographic comma / stop and Enter is the UI's job. The
 * 10-tag and 32-character ceilings mirror `normalizeTags` in `lib/products/service.ts`.
 */
export function TagsField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hintId = `${id}-hint`;

  function commit(raw: string) {
    const candidates = raw
      .split(/[,，、]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (candidates.length === 0) {
      setDraft("");
      return;
    }
    const next = [...value];
    for (const candidate of candidates) {
      if (next.length >= MAX_TAGS) break;
      if (candidate.length > MAX_TAG_LENGTH) continue;
      if (!next.includes(candidate)) next.push(candidate);
    }
    onChange(next);
    setDraft("");
  }

  return (
    <div className="grid gap-1.5">
      <div
        className={cn(
          "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-input px-1.5 py-1 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
          disabled && "pointer-events-none opacity-50",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[12.5px] text-secondary-foreground"
          >
            <span className="max-w-[140px] truncate">{tag}</span>
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((item) => item !== tag));
              }}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}

        <input
          id={id}
          ref={inputRef}
          value={draft}
          disabled={disabled}
          aria-label="添加标签"
          aria-describedby={hintId}
          placeholder={value.length === 0 ? "例如 编辑器、Markdown" : ""}
          className="h-6 min-w-[8ch] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            const next = event.target.value;
            // A pasted or typed comma commits immediately, so the field never holds separators.
            if (/[,，、]/.test(next)) commit(next);
            else setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(draft);
            } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      <p id={hintId} className="text-[12.5px] text-muted-foreground">
        回车或逗号添加，最多 {MAX_TAGS} 个、每个不超过 {MAX_TAG_LENGTH} 字。
      </p>
    </div>
  );
}

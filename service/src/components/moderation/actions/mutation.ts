"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Review actions are HTTP calls, not server actions (plan §7.4 item 6 keeps the API the
 * only mutation surface). The console posts, toasts on success, refreshes the server
 * component, and keeps blocking errors next to the form that caused them.
 */

export type ModerationAction = "approve" | "reject" | "delist";

export type ModerationTarget = { kind: "product" | "version"; id: string };

export class ModerationRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModerationRequestError";
    this.code = code;
  }
}

const ERROR_TEXT: Record<string, string> = {
  unauthenticated: "会话已过期，请重新登录后再操作。",
  forbidden: "当前账号没有审核权限。",
  cross_origin: "请求没有通过同源校验，请从商城页面重新操作。",
  invalid_state: "目标状态已经变化，刷新后再决定。",
  invalid_body: "请求内容不合法，请重试。",
  invalid_json: "请求内容不合法，请重试。",
  invalid_reason: "理由需要 1 到 500 个字。",
  reason_required: "请填写理由。",
  not_found: "目标不存在，或已经被处理。",
  product_not_published: "产品还没有发布，无法单独批准这个版本。",
  network_error: "网络请求失败，请重试。",
};

export function moderationEndpoint(
  target: ModerationTarget,
  action: ModerationAction,
): string {
  const collection = target.kind === "product" ? "products" : "versions";
  return `/api/moderation/${collection}/${encodeURIComponent(target.id)}/${action}`;
}

/** `{ code, message }` on failure — the code is the contract, the message is a fallback. */
export async function postModerationAction(
  path: string,
  body?: Record<string, unknown>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ModerationRequestError("network_error", ERROR_TEXT.network_error);
  }

  if (response.ok) return;

  const payload = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
  } | null;
  const code = typeof payload?.code === "string" ? payload.code : "request_failed";
  const serverMessage =
    typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : null;

  throw new ModerationRequestError(
    code,
    ERROR_TEXT[code] ?? serverMessage ?? `操作失败（${code}）。`,
  );
}

/** Shared submit state: pending flag, blocking error, and the refresh after success. */
export function useModerationSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const run = useCallback(
    async (
      target: ModerationTarget,
      action: ModerationAction,
      options: { body?: Record<string, unknown>; success: string },
    ): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        await postModerationAction(
          moderationEndpoint(target, action),
          options.body,
        );
        toast.success(options.success);
        router.refresh();
        return true;
      } catch (cause) {
        setError(
          cause instanceof ModerationRequestError
            ? cause.message
            : "操作失败，请重试。",
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { pending, error, clearError, run };
}

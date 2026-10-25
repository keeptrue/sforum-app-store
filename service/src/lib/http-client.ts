/**
 * The one way any client surface talks to the API: same-origin `fetch` with the session
 * cookie, `{ code, message }` turned into a typed failure. Nothing here throws, so a caller
 * can keep the error next to the control that caused it instead of losing it to an error
 * boundary.
 *
 * Shared by the developer dashboard and the admin console — the two surfaces must not drift
 * into different error shapes.
 */

export type ApiFailure = {
  status: number;
  code: string;
  message: string;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ApiFailure };

function asFailure(status: number, body: unknown): ApiFailure {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    status,
    code: typeof record.code === "string" ? record.code : "unknown_error",
    message: typeof record.message === "string" ? record.message : "",
  };
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "include" });
  } catch {
    return {
      ok: false,
      failure: { status: 0, code: "network_error", message: "" },
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, failure: asFailure(response.status, body) };
  return { ok: true, data: body as T };
}

export function jsonRequest<T>(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<ApiResult<T>> {
  return requestJson<T>(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * One file part named `file`. Content-Type is left to the browser on purpose: the API judges
 * the bytes, never the declared type.
 */
export function uploadImage<T>(url: string, file: File): Promise<ApiResult<T>> {
  const form = new FormData();
  form.append("file", file);
  return requestJson<T>(url, { method: "POST", body: form });
}

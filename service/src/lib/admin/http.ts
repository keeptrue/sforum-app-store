import { AdminError } from "@/lib/admin/errors";
import { jsonError } from "@/lib/auth/http";
import { ConfigError } from "@/lib/config";

/** Turns a domain failure into the `{ code, message }` shape every client helper expects. */
export function adminErrorResponse(error: unknown): Response {
  if (error instanceof AdminError) {
    return jsonError(error.code, error.status, error.message);
  }
  if (error instanceof ConfigError) {
    return jsonError("config_error", 500, error.message);
  }
  console.error("[admin] unexpected error", error);
  return jsonError("internal_error", 500);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdminError("invalid_body", 400, "请求体必须是 JSON 对象");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminError) throw error;
    throw new AdminError("invalid_json", 400, "请求体不是合法 JSON");
  }
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; max?: number } = {},
): string {
  const raw = body[key];
  const value = typeof raw === "string" ? raw : "";
  if (options.required && !value.trim()) {
    throw new AdminError("missing_field", 400, `缺少字段 ${key}`);
  }
  if (options.max && value.length > options.max) {
    throw new AdminError("text_too_long", 400, `字段 ${key} 超过 ${options.max} 字符`);
  }
  return value;
}

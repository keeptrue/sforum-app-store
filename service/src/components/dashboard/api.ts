/**
 * The dashboard's entry point to the shared client helpers. The implementation lives in
 * `lib/http-client.ts` because the admin console uses the same error shape.
 *
 * There is no upload helper: product identity comes from GitHub (manifest name, README,
 * social preview), so the dashboard never posts a file.
 */

export {
  requestJson,
  jsonRequest,
  type ApiFailure,
  type ApiResult,
} from "@/lib/http-client";

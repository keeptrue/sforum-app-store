import { fileTypeFromBuffer } from "file-type";
import { imageSize } from "image-size";

/**
 * Upload admission for product images.
 *
 * Two independent judgements, in this order:
 * 1. a markup sniff on the leading bytes, so an SVG/XML document renamed to `.png`
 *    is rejected before any decoder sees it (defence against XSS smuggled as an image);
 * 2. `file-type` magic numbers - the ONLY format judgement. The filename and the
 *    request `Content-Type` are caller-controlled and never consulted.
 *
 * `image-size` is only used for width/height; v1 does not rescale (no `sharp`).
 */

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 4096;

const SNIFF_BYTES = 512;

/** Leading bytes that identify an XML/vector document rather than a bitmap. */
const MARKUP_PREFIXES = ["<svg", "<?xml", "<!doctype"];

const ACCEPTED_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
} as const;

export type ImageMime = (typeof ACCEPTED_MIME)[keyof typeof ACCEPTED_MIME];

export type ImageValidation =
  | { ok: true; mime: ImageMime; width: number; height: number }
  | {
      ok: false;
      code: "image_too_large" | "unsupported_image" | "image_dimensions_too_large";
    };

function startsWithMarkup(bytes: Uint8Array): boolean {
  // Skip a UTF-8 BOM and leading whitespace, then compare case-insensitively.
  const offset =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 3
      : 0;
  const head = Buffer.from(
    bytes.subarray(offset, offset + SNIFF_BYTES),
  )
    .toString("latin1")
    .replace(/^[\s]+/, "")
    .toLowerCase();
  return MARKUP_PREFIXES.some((prefix) => head.startsWith(prefix));
}

export async function validateImage(bytes: Uint8Array): Promise<ImageValidation> {
  // Cheapest check first: never hand a >4 MiB buffer to a decoder.
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, code: "image_too_large" };
  }
  if (bytes.byteLength === 0) return { ok: false, code: "unsupported_image" };
  if (startsWithMarkup(bytes)) return { ok: false, code: "unsupported_image" };

  let mime: ImageMime | undefined;
  try {
    const detected = await fileTypeFromBuffer(bytes);
    if (detected) {
      mime = ACCEPTED_MIME[detected.ext as keyof typeof ACCEPTED_MIME];
    }
  } catch {
    return { ok: false, code: "unsupported_image" };
  }
  if (!mime) return { ok: false, code: "unsupported_image" };

  let width: number;
  let height: number;
  try {
    const size = imageSize(bytes);
    width = size.width;
    height = size.height;
  } catch {
    return { ok: false, code: "unsupported_image" };
  }

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE
  ) {
    return { ok: false, code: "image_dimensions_too_large" };
  }

  return { ok: true, mime, width, height };
}

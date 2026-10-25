import { describe, expect, test } from "bun:test";

import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, validateImage } from "./image";

// Real 1x1 fixtures. The point of the magic-number tests is that the caller's
// filename/Content-Type never participates, so no fixture carries a name.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);
const WEBP = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  "base64",
);
const GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const BMP = Buffer.concat([
  Buffer.from("BM", "latin1"),
  Buffer.alloc(60, 0),
]);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
  "utf8",
);

/** Replace the IHDR width/height of the 1x1 PNG (offsets 16..24). */
function pngWithSize(width: number, height: number): Buffer {
  const bytes = Buffer.from(PNG);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("validateImage", () => {
  test("accepts PNG, JPEG and WebP and reports the canonical mime", async () => {
    await expect(validateImage(PNG)).resolves.toEqual({
      ok: true,
      mime: "image/png",
      width: 1,
      height: 1,
    });
    await expect(validateImage(JPEG)).resolves.toEqual({
      ok: true,
      mime: "image/jpeg",
      width: 1,
      height: 1,
    });
    await expect(validateImage(WEBP)).resolves.toEqual({
      ok: true,
      mime: "image/webp",
      width: 1,
      height: 1,
    });
  });

  test("rejects SVG text renamed to .png", async () => {
    await expect(validateImage(SVG)).resolves.toEqual({
      ok: false,
      code: "unsupported_image",
    });
  });

  test("rejects XML prologs and doctypes behind a BOM and whitespace", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const variants = [
      Buffer.concat([bom, Buffer.from("\n  <svg", "latin1")]),
      Buffer.from("\n\t<?xml version=\"1.0\"?><svg/>", "latin1"),
      Buffer.from("  <!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\">", "latin1"),
      // Uppercase must not slip through the sniff.
      Buffer.from("<SVG xmlns=\"http://www.w3.org/2000/svg\"/>", "latin1"),
    ];
    for (const variant of variants) {
      await expect(validateImage(variant)).resolves.toEqual({
        ok: false,
        code: "unsupported_image",
      });
    }
  });

  test("rejects GIF, BMP and garbage by magic number alone", async () => {
    for (const bytes of [GIF, BMP, Buffer.from("definitely not an image")]) {
      await expect(validateImage(bytes)).resolves.toEqual({
        ok: false,
        code: "unsupported_image",
      });
    }
    await expect(validateImage(new Uint8Array(0))).resolves.toEqual({
      ok: false,
      code: "unsupported_image",
    });
  });

  test("rejects PNG bytes whose chunk header is corrupt", async () => {
    // Valid signature, no IHDR chunk: the decoder refuses it, so it must not pass.
    const corrupt = Buffer.from(PNG);
    corrupt.write("XXXX", 12, "latin1");
    for (const bytes of [corrupt, PNG.subarray(0, 14)]) {
      await expect(validateImage(bytes)).resolves.toEqual({
        ok: false,
        code: "unsupported_image",
      });
    }
  });

  test("rejects payloads over MAX_IMAGE_BYTES before sniffing", async () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x41);
    await expect(validateImage(oversized)).resolves.toEqual({
      ok: false,
      code: "image_too_large",
    });

    const oversizedPng = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES, 0)]);
    await expect(validateImage(oversizedPng)).resolves.toEqual({
      ok: false,
      code: "image_too_large",
    });
  });

  test("enforces MAX_IMAGE_EDGE per edge and rejects zero dimensions", async () => {
    const exact = pngWithSize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE);
    await expect(validateImage(exact)).resolves.toEqual({
      ok: true,
      mime: "image/png",
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
    });

    for (const [width, height] of [
      [MAX_IMAGE_EDGE + 1, 1],
      [1, MAX_IMAGE_EDGE + 1],
      [0, 1],
      [1, 0],
    ]) {
      await expect(validateImage(pngWithSize(width, height))).resolves.toEqual({
        ok: false,
        code: "image_dimensions_too_large",
      });
    }
  });
});

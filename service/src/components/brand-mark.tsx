/**
 * The one brand asset. `public/brand/sforum-logo.svg` is the app mark, the favicon and
 * the apple/shortcut icon, so the header, the console rail and the browser tab all show
 * the same bytes. It is loaded as a plain <img> from that shared file rather than
 * re-drawn inline at each spot — a re-draw would let the header drift from the tab.
 *
 * `size` is the rendered box. The glyph sits inside the asset's own padding, so the
 * visible mark is a little smaller than the box; the same file is what the tab icon
 * shows at any resolution.
 *
 * `alt=""` on purpose: the wordmark beside it carries the name, and repeating it for
 * every header would be noise for screen readers.
 */
export function BrandMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/brand/sforum-logo.svg"
      alt=""
      width={size}
      height={size}
      className={`shrink-0 ${className ?? ""}`}
    />
  );
}

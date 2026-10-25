"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Image zoom for a rendered README.
 *
 * A `<dialog>` rather than a portal + fixed overlay: `showModal()` already brings focus
 * trapping, the backdrop, and Escape-to-close, and none of that has to be reimplemented.
 * The image is opened at its natural size, capped to the viewport, so a screenshot that was
 * squeezed into a table cell becomes readable without a second request.
 */
export type LightboxImage = { src: string; alt: string };

export function ImageLightbox({
  image,
  onClose,
}: {
  image: LightboxImage | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (image && !dialog.open) dialog.showModal();
    if (!image && dialog.open) dialog.close();
  }, [image]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      // A click that lands on the dialog itself (not its children) is a backdrop click.
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="max-h-[92vh] max-w-[92vw] rounded-panel border border-border bg-card p-2 backdrop:bg-black/70"
    >
      {image ? (
        <figure className="flex max-h-[86vh] max-w-[88vw] flex-col gap-2">
          <img
            src={image.src}
            alt={image.alt}
            className="min-h-0 w-auto max-w-full flex-1 object-contain"
          />
          <figcaption className="flex items-center justify-between gap-4 px-1 pb-1 text-[12px] text-muted-foreground">
            <span className="truncate">{image.alt || "README 图片"}</span>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-[8px] border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              关闭
            </button>
          </figcaption>
        </figure>
      ) : null}
    </dialog>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { ImageLightbox, type LightboxImage } from "./image-lightbox";

/**
 * The rendered README, plus the three behaviours the stored HTML cannot carry.
 *
 * The HTML comes from the server (`lib/readme/render.ts`) and is already sanitised, so it is
 * injected once and never reconciled again: everything below only *adds* nodes and listeners
 * to that inert subtree. That is why the copy buttons are not part of the stored HTML — the
 * database row stays a pure document, and a change to the chrome does not need a re-render of
 * every product.
 *
 * Zoom threshold: an image narrower than `MIN_ZOOM_WIDTH` is a badge or an icon, and opening
 * a 20px shield in a dialog is noise. Width is read at click time because `loading="lazy"`
 * means most images have no layout box when this effect runs.
 */
const MIN_ZOOM_WIDTH = 200;

export function ReadmeContent({
  id,
  html,
  className,
}: {
  /** Needed by `ReadmeToc`, which reads the headings out of this container. */
  id?: string;
  html: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<LightboxImage | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const cleanups: Array<() => void> = [];

    // Copy buttons live on the wrapper, not on `pre`: the wrapper is the box that does not
    // scroll, so the button stays put while a long line scrolls underneath it.
    for (const block of root.querySelectorAll<HTMLElement>(".readme-code")) {
      const code = block.querySelector("pre");
      if (!code) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "readme-copy";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码");
      button.dataset.copied = "false";

      let reset: ReturnType<typeof setTimeout> | undefined;
      const onClick = async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? "");
          button.textContent = "已复制";
          button.dataset.copied = "true";
        } catch {
          button.textContent = "复制失败";
        }
        if (reset) clearTimeout(reset);
        reset = setTimeout(() => {
          button.textContent = "复制";
          button.dataset.copied = "false";
        }, 2000);
      };

      button.addEventListener("click", onClick);
      block.appendChild(button);
      cleanups.push(() => {
        if (reset) clearTimeout(reset);
        button.removeEventListener("click", onClick);
        button.remove();
      });
    }

    // Make a zoomable image reachable by keyboard. The click handler below is delegated and
    // applies the same width rule, so a late-loading image behaves like an early one.
    for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
      if (image.closest("a")) continue;
      const decorate = () => {
        if (image.getBoundingClientRect().width < MIN_ZOOM_WIDTH) return;
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", `放大查看：${image.alt || "README 图片"}`);
      };
      if (image.complete) {
        decorate();
      } else {
        image.addEventListener("load", decorate, { once: true });
        cleanups.push(() => image.removeEventListener("load", decorate));
      }
    }

    const open = (image: HTMLImageElement) => {
      if (image.getBoundingClientRect().width < MIN_ZOOM_WIDTH) return;
      setPreview({ src: image.currentSrc || image.src, alt: image.alt });
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const image = target.closest("img");
      if (!image || image.closest("a")) return;
      event.preventDefault();
      open(image);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      event.preventDefault();
      open(target);
    };

    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    cleanups.push(() => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
    });

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [html]);

  return (
    <>
      <div
        ref={rootRef}
        id={id}
        className={className}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <ImageLightbox image={preview} onClose={() => setPreview(null)} />
    </>
  );
}

"use client";

import { useSyncExternalStore, type ReactNode } from "react";

import { Panel, PanelGroup, ResizeHandle } from "@/components/ui/resizable";

/**
 * Two-pane console. The panes are server-rendered and arrive as nodes, so this component
 * owns nothing but geometry: `react-resizable-panels` above `md`, a single column (queue
 * above detail) below it.
 *
 * The media query is read with `useSyncExternalStore` instead of rendering both layouts
 * and hiding one: a duplicated queue would double every link and every action button in
 * the document, and `display:none` is a fragile way to keep the accessibility tree clean.
 */

const WIDE_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getSnapshot() {
  return window.matchMedia(WIDE_QUERY).matches;
}

// The console is a desktop surface, so the server HTML is the two-pane layout: a desktop
// reviewer never sees the stacked page first, and a narrow viewport corrects itself on
// hydration (the group clips, so the intermediate state cannot overflow the page).
function getServerSnapshot() {
  return true;
}

export function ModerationShell({
  queue,
  detail,
}: {
  queue: ReactNode;
  detail: ReactNode;
}) {
  const wide = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (!wide) {
    return (
      <div className="overflow-hidden surface">
        {queue}
        <div className="border-t border-border">{detail}</div>
      </div>
    );
  }

  return (
    <PanelGroup
      id="moderation-console"
      orientation="horizontal"
      className="min-h-0 overflow-hidden surface md:flex-1"
    >
      <Panel id="queue" defaultSize="27" minSize="252px" maxSize="42" className="min-h-0">
        {queue}
      </Panel>
      <ResizeHandle aria-label="调整队列宽度" />
      <Panel id="detail" minSize="480px" className="min-h-0">
        {detail}
      </Panel>
    </PanelGroup>
  );
}

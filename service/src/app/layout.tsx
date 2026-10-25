import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";

import "./globals.css";
import { THEME_BOOTSTRAP } from "@/components/theme/theme";
import { Toaster } from "@/components/ui/sonner";

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "SForum Store",
    template: "%s · SForum Store",
  },
  description: "SForum 扩展目录：浏览、核对并安装插件与主题。",
  // The tab icon is the same asset the headers render, so the mark in the page and the
  // mark in the tab can never drift apart. SVG only: the toolchain has no rasterizer
  // (sharp is out of scope), and browsers scale it for any tab size.
  icons: {
    icon: [
      { url: "/brand/sforum-logo.svg", type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: "/brand/sforum-logo.svg",
    apple: "/brand/sforum-logo.svg",
  },
};

/**
 * Chrome lives in the route-group layouts, not here: every face mounts the same
 * `AppShell` (rail + top bar) with its own nav. Only the document shell, the fonts,
 * the theme bootstrap and the toast surface are global.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${instrument.variable} ${jetbrains.variable}`}
    >
      <body>
        {/* Applies the persisted light/dark/system choice before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
        <Toaster />
      </body>
    </html>
  );
}

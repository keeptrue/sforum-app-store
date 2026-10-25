"use client";

import { create } from "zustand";

/**
 * Presentational install target. The catalog and product pages fill it from server data
 * (`ProductDetail` / `CatalogPageBody`) right before opening the dialog, so the dialog
 * itself never looks anything up and never invents a digest.
 */
export type InstallTarget = {
  slug: string;
  name: string;
  version: string;
  platforms: {
    os: string;
    arch: string;
    sha256?: string;
    size?: number;
    filename?: string;
  }[];
};

type InstallDialogState = {
  target: InstallTarget | null;
  open: (target: InstallTarget) => void;
  close: () => void;
};

export const useInstallDialog = create<InstallDialogState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

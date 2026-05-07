// Armin Mehri — mehri.armin@gmail.com
import { useShallow } from "zustand/react/shallow";

import { useBackgroundJobs } from "./backgroundJobs";

export interface FrameExtractStatusView {
  status: "running" | "completed" | "failed" | "idle";
  phase: "decoding" | "uploading" | "done" | "idle";
  decoded: number;
  expected: number;
  uploaded: number;
  message?: string;
}

/**
 * v3.26 — single source of truth for "is this asset's frames currently
 * being extracted, and how far along?" Reads from the same Zustand
 * store the BackgroundJobsBar polls into. No per-card pollers.
 *
 * Uses ``useShallow`` because the selector returns a fresh object each
 * render; without it Zustand v5 sees a new reference every tick and
 * triggers an infinite rerender loop.
 */
export function useAssetExtractStatus(
  assetId: string | undefined,
): FrameExtractStatusView | undefined {
  return useBackgroundJobs(
    useShallow((s): FrameExtractStatusView | undefined => {
      if (!assetId) return undefined;
      const job = Object.values(s.jobs).find(
        (j) => j.kind === "frame-extract" && j.assetId === assetId,
      );
      if (!job?.progress) return undefined;
      const p = job.progress;
      return {
        status: (p.status as FrameExtractStatusView["status"]) ?? "idle",
        phase: (p.phase as FrameExtractStatusView["phase"]) ?? "idle",
        decoded: p.decoded ?? 0,
        expected: p.expected ?? 0,
        uploaded: p.uploaded ?? 0,
        message: p.message,
      };
    }),
  );
}

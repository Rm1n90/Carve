// Armin Mehri — mehri.armin@gmail.com
/**
 * Backgrounded long-running jobs (v3.22).
 *
 * The "Background" button in any batch-job dialog (auto-annotate,
 * YOLO predict, SAM refine, polygon-convert post-process, retrain,
 * export, frame-extract) registers the in-flight job here, then
 * closes the dialog without canceling. The floating
 * <BackgroundJobsBar /> in AppShell shows the live progress and
 * exposes "Expand" + "Cancel" affordances.
 *
 * Design notes:
 *
 * - The store owns ONLY metadata (job_id, kind, label, taskId, +
 *   per-kind handlers). Polling lives in the bar's per-job entry so
 *   the React-Query cache stays warm across dialog mount/unmount.
 *
 * - ``cancel`` is a kind-aware async — each registration supplies a
 *   ``cancel`` closure that calls the right backend API. The store
 *   never imports `samApi` etc directly; that would create circular
 *   coupling and force every consumer to live in the same chunk.
 *
 * - ``expandRequest`` is a one-shot signal: dialog parents subscribe
 *   to this, and when their job's id matches, they re-open the
 *   dialog in "progress" mode without re-prompting for config.
 *
 * - All jobs are scoped to a ``taskId``; the route guard uses
 *   ``forTask(taskId)`` to decide whether to warn on navigation.
 */

import { create } from "zustand";

export type BackgroundJobKind =
  | "sam-auto-text"
  | "sam-auto-visual"
  | "yolo-predict-batch"
  | "yoloe-batch"
  | "sam-refine-batch"
  | "polygon-convert"
  | "yolo-retrain"
  | "export"
  | "frame-extract";

export interface BackgroundJobProgress {
  status: string; // "running" | "completed" | "completed_with_errors" | "failed" | "canceled"
  done?: number;
  total?: number;
  failed?: number;
  message?: string;
  // v3.26 — frame-extract specifics. Optional so other kinds ignore them.
  // The bar's frame-extract poller writes these via setProgress; readers
  // for other job kinds (auto-annotate, retrain, etc.) safely skip them.
  phase?: "decoding" | "uploading" | "done" | "idle";
  decoded?: number;
  expected?: number;
  uploaded?: number;
}

export interface BackgroundJob {
  jobId: string;
  taskId: string;
  kind: BackgroundJobKind;
  label: string; // e.g. "SAM auto-annotate"
  startedAt: number;
  // v3.26 — when set, the bar can match a job to a specific asset for
  // per-card overlays in AssetGrid. Required for kind:"frame-extract";
  // optional elsewhere.
  assetId?: string;
  // Async cancel — the dialog supplies this when registering. Returns
  // when the server has acknowledged the cancel request (the worker
  // typically stops within ~1 asset). Errors are surfaced as a toast
  // and the job is left in the store (operator can retry cancel).
  cancel: () => Promise<void>;
  // Optional latest progress snapshot; the bar's per-job poller
  // updates this so anybody reading the store (route guard, leave
  // dialog) sees the current state without subscribing to the query.
  progress?: BackgroundJobProgress;
}

interface BackgroundJobsStore {
  jobs: Record<string, BackgroundJob>;
  // One-shot expand signal. Set when the operator clicks "Expand"
  // on the floating bar; the dialog parent listens via useEffect,
  // opens the dialog in progress mode, then calls
  // ``clearExpandRequest`` so the same id doesn't re-trigger.
  expandRequest: string | null;

  add(job: BackgroundJob): void;
  remove(jobId: string): void;
  setProgress(jobId: string, progress: BackgroundJobProgress): void;

  requestExpand(jobId: string): void;
  clearExpandRequest(): void;

  forTask(taskId: string): BackgroundJob[];

  // Cancel every job tied to a task (used by the leave guard).
  cancelByTask(taskId: string): Promise<void>;
  // Cancel everything (used by the unload handler).
  cancelAll(): Promise<void>;
}

export const useBackgroundJobs = create<BackgroundJobsStore>((set, get) => ({
  jobs: {},
  expandRequest: null,

  add: (job) =>
    set((s) => ({
      jobs: { ...s.jobs, [job.jobId]: job },
    })),

  remove: (jobId) =>
    set((s) => {
      const { [jobId]: _removed, ...rest } = s.jobs;
      return { jobs: rest };
    }),

  setProgress: (jobId, progress) =>
    set((s) => {
      const existing = s.jobs[jobId];
      if (!existing) return s;
      return {
        jobs: { ...s.jobs, [jobId]: { ...existing, progress } },
      };
    }),

  requestExpand: (jobId) => set({ expandRequest: jobId }),
  clearExpandRequest: () => set({ expandRequest: null }),

  forTask: (taskId) =>
    Object.values(get().jobs).filter((j) => j.taskId === taskId),

  cancelByTask: async (taskId) => {
    const targets = get().forTask(taskId);
    await Promise.all(
      targets.map(async (j) => {
        try {
          await j.cancel();
        } catch {
          // best-effort; we still remove the entry so the bar clears.
        }
        get().remove(j.jobId);
      }),
    );
  },

  cancelAll: async () => {
    const targets = Object.values(get().jobs);
    await Promise.all(
      targets.map(async (j) => {
        try {
          await j.cancel();
        } catch {
          // best-effort
        }
        get().remove(j.jobId);
      }),
    );
  },
}));

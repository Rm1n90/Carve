// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

import type { RleMask } from "@/api/track";

export type TrackStatus =
  | "idle"
  | "seeding"
  | "previewing"
  | "running"
  | "done"
  | "failed";

export type SeedKind = "click" | "box" | "text";

export interface TrackedObject {
  objId: number;
  classId: string;
  seedFrame: number;
  seedKind: SeedKind;
}

interface State {
  sessionId: string | null;
  status: TrackStatus;
  totalFrames: number;
  framesPropagated: number;
  errorMessage: string | null;
  /** Absolute asset frame index where the open session's window
   *  starts (inclusive). ``null`` when no session is open. Stored on
   *  the bridge — not on the panel-scoped TrackTool — so the value
   *  survives panel unmount/remount (e.g., user switches to bbox
   *  mode and back) and auto-track can pick up the open session. */
  windowStart: number | null;
  /** Last absolute asset frame index inside the open session's
   *  window (inclusive). ``null`` when no session is open. */
  windowEnd: number | null;
  objects: Map<number, TrackedObject>;
  trackIds: Map<number, string>;
  masksByFrame: Map<number, Map<number, RleMask>>;
  /** True while ``TrackTool.autoTrackToEnd`` is iterating windows. The
   *  panel and the badge read this to switch their copy from "one
   *  window" to "auto-tracking N / M windows". */
  autoTracking: boolean;
  /** Approximate count of windows the auto-track loop expects to
   *  cover (computed once at start from the remaining frames and the
   *  initial window size). */
  autoTotalWindows: number;
  /** Number of windows already fully propagated (excludes the in-flight
   *  one). */
  autoCompletedWindows: number;
  /** Last absolute asset frame index the auto-track loop must cover
   *  (the video's last frame). */
  autoLastFrame: number;
}

interface Actions {
  setSession(
    sessionId: string,
    totalFrames: number,
    windowStart?: number,
    windowEnd?: number,
  ): void;
  setStatus(status: TrackStatus, message?: string): void;
  setFramesPropagated(n: number): void;
  registerObject(obj: TrackedObject): void;
  removeObject(objId: number): void;
  reassignClass(objId: number, classId: string): void;
  mergeMasks(frameIdx: number, masks: Record<number, RleMask>): void;
  hitTest(frameIdx: number, x: number, y: number): number | null;
  collectTrackIds(): string[];
  reset(): void;
  /** Start / update / clear auto-track progress counters. Pass
   *  ``{ autoTracking: false }`` to mark the loop done; the totals stay
   *  for one more render so the user sees the final window count. */
  setAutoTracking(opts: {
    autoTracking: boolean;
    autoTotalWindows?: number;
    autoCompletedWindows?: number;
    autoLastFrame?: number;
  }): void;
}

type TrackBridge = State & Actions;

const initial: State = {
  sessionId: null,
  status: "idle",
  totalFrames: 0,
  framesPropagated: 0,
  errorMessage: null,
  windowStart: null,
  windowEnd: null,
  autoTracking: false,
  autoTotalWindows: 0,
  autoCompletedWindows: 0,
  autoLastFrame: 0,
  objects: new Map(),
  trackIds: new Map(),
  masksByFrame: new Map(),
};

function newTrackId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export const useTrackBridge = create<TrackBridge>((set, get) => ({
  ...initial,

  setSession: (sessionId, totalFrames, windowStart, windowEnd) =>
    set({
      sessionId,
      totalFrames,
      status: "seeding",
      windowStart: typeof windowStart === "number" ? windowStart : null,
      windowEnd: typeof windowEnd === "number" ? windowEnd : null,
    }),

  setStatus: (status, message) =>
    set({ status, errorMessage: message ?? null }),

  setFramesPropagated: (n) => set({ framesPropagated: n }),

  registerObject: (obj) =>
    set((s) => {
      const objects = new Map(s.objects);
      objects.set(obj.objId, obj);
      const trackIds = new Map(s.trackIds);
      if (!trackIds.has(obj.objId)) trackIds.set(obj.objId, newTrackId());
      return { objects, trackIds };
    }),

  removeObject: (objId) =>
    set((s) => {
      const objects = new Map(s.objects);
      objects.delete(objId);
      const trackIds = new Map(s.trackIds);
      trackIds.delete(objId);
      const masksByFrame = new Map(s.masksByFrame);
      for (const [f, m] of masksByFrame) {
        const next = new Map(m);
        next.delete(objId);
        masksByFrame.set(f, next);
      }
      return { objects, trackIds, masksByFrame };
    }),

  reassignClass: (objId, classId) =>
    set((s) => {
      const o = s.objects.get(objId);
      if (!o) return s;
      const objects = new Map(s.objects);
      objects.set(objId, { ...o, classId });
      return { objects };
    }),

  mergeMasks: (frameIdx, masks) =>
    set((s) => {
      const masksByFrame = new Map(s.masksByFrame);
      const existing = new Map(masksByFrame.get(frameIdx) ?? []);
      for (const [k, v] of Object.entries(masks)) {
        existing.set(Number(k), v);
      }
      masksByFrame.set(frameIdx, existing);
      return { masksByFrame };
    }),

  hitTest: (frameIdx, x, y) => {
    const frame = get().masksByFrame.get(frameIdx);
    if (!frame) return null;
    for (const [objId, mask] of frame) {
      if (mask.polygon.length >= 3 && pointInPolygon(x, y, mask.polygon)) {
        return objId;
      }
    }
    return null;
  },

  collectTrackIds: () => Array.from(get().trackIds.values()),

  reset: () =>
    set((s) => ({
      ...initial,
      // Preserve auto-track progress across in-loop session resets so
      // the badge keeps counting up; the loop driver clears it when it
      // exits via setAutoTracking({autoTracking: false}).
      autoTracking: s.autoTracking,
      autoTotalWindows: s.autoTracking ? s.autoTotalWindows : 0,
      autoCompletedWindows: s.autoTracking ? s.autoCompletedWindows : 0,
      autoLastFrame: s.autoTracking ? s.autoLastFrame : 0,
      // windowStart/windowEnd reset to null — the next openSession
      // populates them with the new window's bounds.
      windowStart: null,
      windowEnd: null,
      objects: new Map(),
      trackIds: new Map(),
      masksByFrame: new Map(),
    })),

  setAutoTracking: (opts) =>
    set((s) => ({
      autoTracking: opts.autoTracking,
      autoTotalWindows: opts.autoTotalWindows ?? s.autoTotalWindows,
      autoCompletedWindows: opts.autoCompletedWindows ?? s.autoCompletedWindows,
      autoLastFrame: opts.autoLastFrame ?? s.autoLastFrame,
    })),
}));

(useTrackBridge as unknown as { getInitialState: () => State }).getInitialState =
  () => ({
    ...initial,
    objects: new Map(),
    trackIds: new Map(),
    masksByFrame: new Map(),
  });

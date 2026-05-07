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
  objects: Map<number, TrackedObject>;
  trackIds: Map<number, string>;
  masksByFrame: Map<number, Map<number, RleMask>>;
}

interface Actions {
  setSession(sessionId: string, totalFrames: number): void;
  setStatus(status: TrackStatus, message?: string): void;
  setFramesPropagated(n: number): void;
  registerObject(obj: TrackedObject): void;
  removeObject(objId: number): void;
  reassignClass(objId: number, classId: string): void;
  mergeMasks(frameIdx: number, masks: Record<number, RleMask>): void;
  hitTest(frameIdx: number, x: number, y: number): number | null;
  collectTrackIds(): string[];
  reset(): void;
}

type TrackBridge = State & Actions;

const initial: State = {
  sessionId: null,
  status: "idle",
  totalFrames: 0,
  framesPropagated: 0,
  errorMessage: null,
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

  setSession: (sessionId, totalFrames) =>
    set({ sessionId, totalFrames, status: "seeding" }),

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
    set({
      ...initial,
      objects: new Map(),
      trackIds: new Map(),
      masksByFrame: new Map(),
    }),
}));

(useTrackBridge as unknown as { getInitialState: () => State }).getInitialState =
  () => ({
    ...initial,
    objects: new Map(),
    trackIds: new Map(),
    masksByFrame: new Map(),
  });

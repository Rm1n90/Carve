import { create } from "zustand";

export type AnnotationKind = "bbox" | "polygon" | "mask" | "tag";

export interface Bbox { kind: "bbox"; x: number; y: number; w: number; h: number; }
export interface Polygon { kind: "polygon"; points: [number, number][]; }
export interface Mask { kind: "mask_rle"; size: [number, number]; counts: string; }
export interface Tag { kind: "tag"; }
export type Geometry = Bbox | Polygon | Mask | Tag;

export interface AnnotationDraft {
  tempId: string;
  classId: string;
  kind: AnnotationKind;
  geometry: Geometry;
  frameId: string | null;
  serverId: string | null;
  dirty: boolean;
  /**
   * Optional client-generated track identifier. Annotations sharing a
   * trackId belong to the same tracked object across frames (e.g. a
   * multi-object SAM tracking session emits one trackId per obj_id).
   * Defaults to ``null`` for callers that don't track per-object groups.
   */
  trackId?: string | null;
}

interface State {
  byId: Record<string, AnnotationDraft>;
  selectedId: string | null;
  pendingDeletes: string[];
  add: (a: AnnotationDraft) => void;
  update: (id: string, patch: Partial<AnnotationDraft>) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  reset: (initial: AnnotationDraft[]) => void;
  markPersisted: (tempId: string, serverId: string) => void;
  clearPendingDeletes: () => void;
}

export const useAnnotations = create<State>((set) => ({
  byId: {},
  selectedId: null,
  pendingDeletes: [],
  add: (a) =>
    set((s) => ({
      byId: { ...s.byId, [a.tempId]: a },
      selectedId: a.tempId,
    })),
  update: (id, patch) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return { byId: { ...s.byId, [id]: { ...cur, ...patch, dirty: true } } };
    }),
  remove: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      const { [id]: _drop, ...rest } = s.byId;
      return {
        byId: rest,
        selectedId: s.selectedId === id ? null : s.selectedId,
        pendingDeletes: cur.serverId
          ? [...s.pendingDeletes, cur.serverId]
          : s.pendingDeletes,
      };
    }),
  select: (id) => set({ selectedId: id }),
  reset: (initial) =>
    set({
      byId: Object.fromEntries(initial.map((a) => [a.tempId, a])),
      selectedId: null,
      pendingDeletes: [],
    }),
  markPersisted: (tempId, serverId) =>
    set((s) => {
      const cur = s.byId[tempId];
      if (!cur) return s;
      return {
        byId: { ...s.byId, [tempId]: { ...cur, serverId, dirty: false } },
      };
    }),
  clearPendingDeletes: () => set({ pendingDeletes: [] }),
}));

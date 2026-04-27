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
  /** Stacking order — lower paints first. Defaults to 0. */
  zOrder?: number;
}

interface HistorySnapshot {
  byId: Record<string, AnnotationDraft>;
  pendingDeletes: string[];
}

interface State {
  byId: Record<string, AnnotationDraft>;
  selectedId: string | null;
  selectedIds: string[];
  hiddenClassIds: string[];
  hiddenAnnotationIds: string[];
  pendingDeletes: string[];
  history: { past: HistorySnapshot[]; future: HistorySnapshot[] };
  add: (a: AnnotationDraft) => void;
  update: (id: string, patch: Partial<AnnotationDraft>) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;
  selectAll: (frameId: string | null) => void;
  clearSelection: () => void;
  reset: (initial: AnnotationDraft[]) => void;
  markPersisted: (tempId: string, serverId: string) => void;
  clearPendingDeletes: () => void;
  setHiddenForClass: (classId: string, hidden: boolean) => void;
  setHiddenForAnnotation: (annId: string, hidden: boolean) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  bringForward: (id: string) => void;
  sendBackward: (id: string) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

const HISTORY_CAP = 50;

function snapshot(s: { byId: Record<string, AnnotationDraft>; pendingDeletes: string[] }): HistorySnapshot {
  return { byId: s.byId, pendingDeletes: s.pendingDeletes };
}

function pushPast(s: State): { past: HistorySnapshot[]; future: HistorySnapshot[] } {
  const next = [...s.history.past, snapshot(s)];
  if (next.length > HISTORY_CAP) next.shift();
  return { past: next, future: [] };
}

function neighborsByZ(byId: Record<string, AnnotationDraft>, target: AnnotationDraft) {
  const sameFrame = Object.values(byId).filter((a) => a.frameId === target.frameId);
  return sameFrame.sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
}

export const useAnnotations = create<State>((set) => ({
  byId: {},
  selectedId: null,
  selectedIds: [],
  hiddenClassIds: [],
  hiddenAnnotationIds: [],
  pendingDeletes: [],
  history: { past: [], future: [] },
  add: (a) =>
    set((s) => ({
      byId: { ...s.byId, [a.tempId]: a },
      selectedId: a.tempId,
      selectedIds: [a.tempId],
      history: pushPast(s),
    })),
  update: (id, patch) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: { ...s.byId, [id]: { ...cur, ...patch, dirty: true } },
        history: pushPast(s),
      };
    }),
  remove: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      const { [id]: _drop, ...rest } = s.byId;
      return {
        byId: rest,
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => x !== id),
        pendingDeletes: cur.serverId
          ? [...s.pendingDeletes, cur.serverId]
          : s.pendingDeletes,
        history: pushPast(s),
      };
    }),
  select: (id) =>
    set({
      selectedId: id,
      selectedIds: id ? [id] : [],
    }),
  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id);
      const nextIds = has
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id];
      return {
        selectedIds: nextIds,
        selectedId: nextIds.length > 0 ? nextIds[nextIds.length - 1] : null,
      };
    }),
  selectMany: (ids) =>
    set({
      selectedIds: [...ids],
      selectedId: ids.length > 0 ? ids[ids.length - 1] : null,
    }),
  selectAll: (frameId) =>
    set((s) => {
      const ids = Object.values(s.byId)
        .filter((a) => a.frameId === frameId)
        .map((a) => a.tempId);
      return {
        selectedIds: ids,
        selectedId: ids.length > 0 ? ids[ids.length - 1] : null,
      };
    }),
  clearSelection: () => set({ selectedId: null, selectedIds: [] }),
  reset: (initial) =>
    set({
      byId: Object.fromEntries(initial.map((a) => [a.tempId, a])),
      selectedId: null,
      selectedIds: [],
      pendingDeletes: [],
      history: { past: [], future: [] },
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
  setHiddenForClass: (classId, hidden) =>
    set((s) => ({
      hiddenClassIds: hidden
        ? Array.from(new Set([...s.hiddenClassIds, classId]))
        : s.hiddenClassIds.filter((c) => c !== classId),
    })),
  setHiddenForAnnotation: (annId, hidden) =>
    set((s) => ({
      hiddenAnnotationIds: hidden
        ? Array.from(new Set([...s.hiddenAnnotationIds, annId]))
        : s.hiddenAnnotationIds.filter((c) => c !== annId),
    })),
  bringToFront: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      const peers = neighborsByZ(s.byId, cur);
      const maxZ = peers.length > 0 ? (peers[peers.length - 1].zOrder ?? 0) : 0;
      const nextZ = maxZ + 1;
      return {
        byId: { ...s.byId, [id]: { ...cur, zOrder: nextZ, dirty: true } },
        history: pushPast(s),
      };
    }),
  sendToBack: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      const peers = neighborsByZ(s.byId, cur);
      const minZ = peers.length > 0 ? (peers[0].zOrder ?? 0) : 0;
      const nextZ = minZ - 1;
      return {
        byId: { ...s.byId, [id]: { ...cur, zOrder: nextZ, dirty: true } },
        history: pushPast(s),
      };
    }),
  bringForward: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: { ...s.byId, [id]: { ...cur, zOrder: (cur.zOrder ?? 0) + 1, dirty: true } },
        history: pushPast(s),
      };
    }),
  sendBackward: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: { ...s.byId, [id]: { ...cur, zOrder: (cur.zOrder ?? 0) - 1, dirty: true } },
        history: pushPast(s),
      };
    }),
  pushHistory: () => set((s) => ({ history: pushPast(s) })),
  undo: () =>
    set((s) => {
      if (s.history.past.length === 0) return s;
      const past = [...s.history.past];
      const last = past.pop()!;
      return {
        byId: last.byId,
        pendingDeletes: last.pendingDeletes,
        history: { past, future: [...s.history.future, snapshot(s)] },
      };
    }),
  redo: () =>
    set((s) => {
      if (s.history.future.length === 0) return s;
      const future = [...s.history.future];
      const next = future.pop()!;
      return {
        byId: next.byId,
        pendingDeletes: next.pendingDeletes,
        history: { past: [...s.history.past, snapshot(s)], future },
      };
    }),
}));

// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

export type AnnotationKind = "bbox" | "polygon" | "mask" | "tag";

export type ReviewStatus = "proposed" | "accepted" | "rejected";

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
  /**
   * Plan-09 Phase 5 Task 3 — review lifecycle. New drafts default to
   * ``proposed``. Once a reviewer accepts/rejects via the review panel
   * the server stamps ``reviewedById``/``reviewedAt``. ``prevGeometry``
   * preserves the prior geometry on edits-after-accept (server-set).
   *
   * These are typed optional to avoid churn at the ~50 internal callsites
   * that currently construct ``AnnotationDraft`` literals; the store's
   * ``add()`` / ``reset()`` and ``api/annotations#toDraft`` always seed
   * a concrete value (defaulting to ``"proposed"`` when missing).
   */
  status?: ReviewStatus;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  prevGeometry?: Record<string, unknown> | null;
  /**
   * Plan 14 Phase 8 Task 6 — per-annotation color override. When non-null,
   * the canvas paints this color instead of the class color. ``null``
   * resets to the class color.
   */
  colorOverride?: string | null;
}

export interface ReviewStatePatch {
  status?: ReviewStatus;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  prevGeometry?: Record<string, unknown> | null;
}

interface HistorySnapshot {
  byId: Record<string, AnnotationDraft>;
  pendingDeletes: string[];
}

/**
 * Plan-09 Phase 5 Task 13 — undo grouping. Tracks the most recent
 * grouping-eligible operation so that `update()` can decide whether to
 * REPLACE the latest history entry (coalesce contiguous edits) instead
 * of pushing a brand-new one. ``null`` means the next mutation pushes
 * normally regardless of the timing window.
 */
interface LastEditMeta {
  opName: string;
  targetId: string;
  timestamp: number;
}

/**
 * Plan 14 Phase 8 Task 6 — clipboard slice for the right-click "Copy" /
 * "Paste annotation" actions. In-memory only (does not survive reload).
 */
export interface ClipboardEntry {
  geometry: Geometry;
  classId: string;
  kind: AnnotationKind;
  colorOverride: string | null;
}

interface State {
  byId: Record<string, AnnotationDraft>;
  selectedId: string | null;
  selectedIds: string[];
  hiddenClassIds: string[];
  hiddenAnnotationIds: string[];
  pendingDeletes: string[];
  /**
   * Plan 14 Phase 8 Task 6 — locked annotation ids. Locked annotations
   * are excluded from the canvas's body hit-test (so a normal click can't
   * select them), drag/resize handlers no-op early, and they paint with
   * a small lock glyph + slightly distinct alpha. Right-click still hits
   * them so the user can unlock from the context menu.
   */
  lockedIds: Set<string>;
  clipboard: ClipboardEntry | null;
  history: { past: HistorySnapshot[]; future: HistorySnapshot[] };
  /** See {@link LastEditMeta}. Plan-09 Phase 5 Task 13. */
  lastEditMeta: LastEditMeta | null;
  add: (a: AnnotationDraft) => void;
  update: (id: string, patch: Partial<AnnotationDraft>) => void;
  remove: (id: string) => void;
  /**
   * v3.24.14 — bulk delete. Drops every annotation in `ids` in a
   * single `set()` so multi-select delete only triggers one history
   * push + one canvas re-render instead of N (which made the last
   * shape appear to "linger" before being removed).
   */
  removeMany: (ids: string[]) => void;
  /** v3.27 — wipe all annotations whose ``trackId`` is in the given list.
   *  Used by the SAM 3.1 Track Discard flow to undo a tracking session
   *  in one shot without iterating individual ids. */
  removeManyByTrackIds: (trackIds: string[]) => void;
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;
  selectAll: (frameId: string | null) => void;
  clearSelection: () => void;
  reset: (initial: AnnotationDraft[]) => void;
  /**
   * Drop every in-memory draft and clear the pending-delete queue.
   * Used by the editor's "Discard and exit" flow so the user can
   * leave with unsaved changes and the next mount seeds cleanly
   * from server data.
   */
  discardLocal: () => void;
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
  /**
   * Plan-09 Phase 5 Task 3 — apply a review-status patch (used for the
   * optimistic flip when the user clicks Accept/Reject in ReviewPanel
   * AND for applying the authoritative server response after the API
   * resolves). Does NOT mark the draft dirty — review state is server-
   * authoritative and travels via the dedicated /review endpoint, not
   * the geometry batch.
   */
  setReviewState: (id: string, patch: ReviewStatePatch) => void;
  /**
   * Restore a previous review state — called from ReviewPanel's
   * optimistic-failure path so the UI snaps back to the pre-click state
   * when the API rejects.
   */
  revertReviewState: (id: string, prev: ReviewStatePatch) => void;
  // Plan 14 Phase 8 Task 6 — lock / clipboard / duplicate actions.
  isLocked: (id: string) => boolean;
  lock: (id: string) => void;
  unlock: (id: string) => void;
  toggleLock: (id: string) => void;
  /**
   * Clones the annotation with ``id`` offset by (dx, dy) — defaults to
   * (16, 16). Bbox/polygon geometries are clamped to image bounds when
   * ``imageBounds`` is provided. Returns the new tempId, or ``null`` if
   * the source annotation does not exist.
   */
  duplicate: (
    id: string,
    dx?: number,
    dy?: number,
    imageBounds?: { w: number; h: number },
  ) => string | null;
  copyToClipboard: (id: string) => void;
  /**
   * Paste the clipboard entry at the given image-space position. The
   * pasted annotation's geometry is positioned so its top-left (bbox)
   * or first vertex (polygon) lands at (atX, atY). Returns the new
   * tempId, or ``null`` if the clipboard is empty.
   */
  pasteFromClipboard: (
    atX: number,
    atY: number,
    frameId?: string | null,
    imageBounds?: { w: number; h: number },
  ) => string | null;
  /**
   * Plan 14 Phase 8 Task 7 — bulk class-reassign for the current
   * ``selectedIds`` set. Mutates every selected draft's ``classId`` (and
   * marks it dirty) and pushes a SINGLE history entry covering the whole
   * batch — so an undo reverts the entire bulk reassign in one step
   * instead of N steps.
   *
   * Drafts already on ``classId`` are skipped (no-op). If nothing
   * actually changes, the call is a complete no-op (no history push).
   *
   * Pass an explicit ``ids`` array to bulk-reassign a caller-provided
   * set (e.g. the palette's ``selectedAnnotationIds`` prop, which may
   * not match the live ``selectedIds`` slice in test scenarios).
   */
  setActiveClassForSelected: (classId: string, ids?: ReadonlyArray<string>) => void;
}

const HISTORY_CAP = 50;
/**
 * Plan-09 Phase 5 Task 13 — coalesce contiguous edits to the SAME
 * annotation within this many milliseconds into one undo step.
 */
export const UNDO_GROUP_WINDOW_MS = 800;

function snapshot(s: { byId: Record<string, AnnotationDraft>; pendingDeletes: string[] }): HistorySnapshot {
  return { byId: s.byId, pendingDeletes: s.pendingDeletes };
}

/**
 * Restore a history snapshot onto the current state.
 *
 * The naive "replace byId + pendingDeletes" path breaks once snapshots
 * cross save boundaries, because the snapshot's frozen draft refs no
 * longer match the actual server state. This helper reconciles the
 * snapshot with what's currently live, staged, or already gone:
 *
 *   1. Snapshot draft carries a serverId that's still LIVE in current
 *      byId → restore it. If the snapshot's content differs from the
 *      current draft, mark dirty=true so the next save propagates the
 *      reverted state to the server (otherwise a refetch would silently
 *      overwrite our undo with whatever the server has).
 *   2. Snapshot draft carries a serverId that's currently STAGED for
 *      delete → un-stage and restore as-is (the row still exists on
 *      the server; we just cancel the pending delete).
 *   3. Snapshot draft carries a serverId that's NEITHER live NOR
 *      staged → "ghost" serverId. The row was already saved-deleted
 *      from the server. Restore as a fresh CREATE (serverId=null,
 *      dirty=true) so the next save POSTs a replacement.
 *   4. Snapshot draft has no serverId but the current state has one
 *      under the same tempId → autosave happened after the snapshot
 *      was captured. Carry forward the live serverId and mark dirty
 *      (so the snapshot's content goes back to the server).
 *   5. Snapshot draft has no serverId and current state has none
 *      either → never-saved create. Restore as-is (still dirty).
 *
 * pendingDeletes is recomputed from the CURRENT pendingDeletes plus
 * any vanishing live serverIds. Seeding from snap.pendingDeletes would
 * resurrect stale serverIds whose rows the server already deleted —
 * the resulting batch delete would 404 and fail the entire save.
 */
function draftContentEqual(a: AnnotationDraft, b: AnnotationDraft): boolean {
  if (a.classId !== b.classId) return false;
  if (a.kind !== b.kind) return false;
  if ((a.trackId ?? null) !== (b.trackId ?? null)) return false;
  if ((a.zOrder ?? 0) !== (b.zOrder ?? 0)) return false;
  if ((a.status ?? "proposed") !== (b.status ?? "proposed")) return false;
  if ((a.colorOverride ?? null) !== (b.colorOverride ?? null)) return false;
  return JSON.stringify(a.geometry) === JSON.stringify(b.geometry);
}

function applyHistorySnapshot(
  s: { byId: Record<string, AnnotationDraft>; pendingDeletes: string[]; selectedId: string | null; selectedIds: string[] },
  snap: HistorySnapshot,
): {
  byId: Record<string, AnnotationDraft>;
  pendingDeletes: string[];
  selectedId: string | null;
  selectedIds: string[];
} {
  const liveServerIds = new Set<string>();
  for (const d of Object.values(s.byId)) {
    if (d.serverId) liveServerIds.add(d.serverId);
  }
  const stagedDelSet = new Set(s.pendingDeletes);

  const restoredById: Record<string, AnnotationDraft> = {};
  const restoredServerIds = new Set<string>();
  for (const [tempId, draft] of Object.entries(snap.byId)) {
    const cur = s.byId[tempId];
    if (draft.serverId) {
      if (liveServerIds.has(draft.serverId)) {
        // Row is still live server-side. Mark dirty only if the
        // snapshot's content differs from current — most undos are
        // pure replays (an unrelated entry was added/deleted) and
        // shouldn't queue no-op updates for every other annotation.
        const dirty = !cur || !draftContentEqual(cur, draft);
        restoredById[tempId] = dirty
          ? { ...draft, dirty: true }
          : { ...draft, dirty: cur ? cur.dirty : draft.dirty };
        restoredServerIds.add(draft.serverId);
      } else if (stagedDelSet.has(draft.serverId)) {
        // Row exists server-side but was staged for delete — un-stage
        // by adding to restoredServerIds (the augmented-pending pass
        // below strips them).
        restoredById[tempId] = draft;
        restoredServerIds.add(draft.serverId);
      } else {
        // Ghost serverId — server already deleted this row. Restore
        // as a re-create so the next save POSTs it back.
        restoredById[tempId] = { ...draft, serverId: null, dirty: true };
      }
    } else if (cur?.serverId) {
      // Snapshot pre-dates autosave. Carry forward the live serverId
      // and mark dirty so the snapshot's content propagates to server.
      restoredById[tempId] = { ...draft, serverId: cur.serverId, dirty: true };
      restoredServerIds.add(cur.serverId);
    } else {
      restoredById[tempId] = draft;
    }
  }

  // Recompute pendingDeletes from CURRENT pendingDeletes (live) plus
  // vanishing live serverIds. We intentionally do NOT seed from
  // snap.pendingDeletes — those serverIds may have been flushed by an
  // intervening save and re-staging them would 404 the next batch.
  const augmented = new Set<string>(s.pendingDeletes);
  for (const draft of Object.values(s.byId)) {
    if (draft.serverId && !restoredServerIds.has(draft.serverId)) {
      augmented.add(draft.serverId);
    }
  }
  // Anything coming BACK via the restore should not also be queued
  // for delete.
  for (const sid of restoredServerIds) augmented.delete(sid);

  const survivingSelectedIds = s.selectedIds.filter((id) => id in restoredById);
  const survivingSelectedId =
    s.selectedId && s.selectedId in restoredById ? s.selectedId : null;
  return {
    byId: restoredById,
    pendingDeletes: Array.from(augmented),
    selectedId: survivingSelectedId,
    selectedIds: survivingSelectedIds,
  };
}

function pushPast(s: State): { past: HistorySnapshot[]; future: HistorySnapshot[] } {
  const next = [...s.history.past, snapshot(s)];
  if (next.length > HISTORY_CAP) next.shift();
  return { past: next, future: [] };
}

/**
 * Plan-09 Phase 5 Task 13 — append-or-replace history push for grouping
 * eligible operations. If ``s.lastEditMeta`` matches ``opName`` +
 * ``targetId`` and falls within ``UNDO_GROUP_WINDOW_MS`` of ``now``, the
 * latest snapshot is REPLACED with the pre-update state (i.e. the new
 * snapshot is dropped — the existing entry already represents the state
 * before the run of edits started). Otherwise behaves exactly like
 * ``pushPast``.
 */
function pushPastGrouped(
  s: State,
  opName: string,
  targetId: string,
  now: number,
): { past: HistorySnapshot[]; future: HistorySnapshot[] } {
  const meta = s.lastEditMeta;
  const sameOp =
    meta !== null &&
    meta.opName === opName &&
    meta.targetId === targetId &&
    now - meta.timestamp <= UNDO_GROUP_WINDOW_MS &&
    s.history.past.length > 0;
  if (sameOp) {
    // Drop the would-be new snapshot — the existing tail already holds
    // the pre-edit state for this run of grouped edits.
    return { past: s.history.past, future: [] };
  }
  return pushPast(s);
}

function neighborsByZ(byId: Record<string, AnnotationDraft>, target: AnnotationDraft) {
  const sameFrame = Object.values(byId).filter((a) => a.frameId === target.frameId);
  return sameFrame.sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
}

export const useAnnotations = create<State>((set, get) => ({
  byId: {},
  selectedId: null,
  selectedIds: [],
  hiddenClassIds: [],
  hiddenAnnotationIds: [],
  pendingDeletes: [],
  lockedIds: new Set<string>(),
  clipboard: null,
  history: { past: [], future: [] },
  lastEditMeta: null,
  add: (a) =>
    set((s) => {
      // Plan-09 Phase 5 Task 3 — every new draft enters the review
      // pipeline as "proposed" unless the caller already set a value
      // (e.g. a draft hydrated from the server already carries its
      // server-authoritative status).
      const seeded: AnnotationDraft = {
        ...a,
        status: a.status ?? "proposed",
        reviewedById: a.reviewedById ?? null,
        reviewedAt: a.reviewedAt ?? null,
        prevGeometry: a.prevGeometry ?? null,
      };
      return {
        byId: { ...s.byId, [a.tempId]: seeded },
        selectedId: a.tempId,
        selectedIds: [a.tempId],
        history: pushPast(s),
        // Non-update op flushes the grouping window — the next update()
        // will start a fresh undo entry.
        lastEditMeta: null,
      };
    }),
  update: (id, patch) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      const now = Date.now();
      // Plan-09 Phase 5 Task 13 — coalesce contiguous edits to the same
      // annotation within UNDO_GROUP_WINDOW_MS into one history entry.
      const history = pushPastGrouped(s, "update", id, now);
      return {
        byId: { ...s.byId, [id]: { ...cur, ...patch, dirty: true } },
        history,
        lastEditMeta: { opName: "update", targetId: id, timestamp: now },
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
        lastEditMeta: null,
      };
    }),
  removeMany: (ids) =>
    set((s) => {
      if (ids.length === 0) return s;
      const drop = new Set(ids);
      const nextById: typeof s.byId = {};
      const newPendingServerIds: string[] = [];
      let removed = 0;
      for (const [k, v] of Object.entries(s.byId)) {
        if (drop.has(k)) {
          if (v.serverId) newPendingServerIds.push(v.serverId);
          removed++;
          continue;
        }
        nextById[k] = v;
      }
      // Nothing actually matched — bail without churning history.
      if (removed === 0) return s;
      return {
        byId: nextById,
        selectedId: s.selectedId && drop.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => !drop.has(x)),
        pendingDeletes:
          newPendingServerIds.length > 0
            ? [...s.pendingDeletes, ...newPendingServerIds]
            : s.pendingDeletes,
        history: pushPast(s),
        lastEditMeta: null,
      };
    }),
  removeManyByTrackIds: (trackIds) =>
    set((s) => {
      if (trackIds.length === 0) return s;
      const drop = new Set(trackIds);
      const nextById: typeof s.byId = {};
      const newPendingServerIds: string[] = [];
      let removed = 0;
      const removedKeys = new Set<string>();
      for (const [k, v] of Object.entries(s.byId)) {
        if (v.trackId && drop.has(v.trackId)) {
          if (v.serverId) newPendingServerIds.push(v.serverId);
          removed++;
          removedKeys.add(k);
          continue;
        }
        nextById[k] = v;
      }
      if (removed === 0) return s;
      return {
        byId: nextById,
        selectedId:
          s.selectedId && removedKeys.has(s.selectedId) ? null : s.selectedId,
        selectedIds: s.selectedIds.filter((x) => !removedKeys.has(x)),
        pendingDeletes:
          newPendingServerIds.length > 0
            ? [...s.pendingDeletes, ...newPendingServerIds]
            : s.pendingDeletes,
        history: pushPast(s),
        lastEditMeta: null,
      };
    }),
  select: (id) =>
    set({
      selectedId: id,
      selectedIds: id ? [id] : [],
      // Selection move flushes the undo-grouping window so the next
      // update() on the new selection starts a fresh entry. Plan-09
      // Phase 5 Task 13.
      lastEditMeta: null,
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
        lastEditMeta: null,
      };
    }),
  selectMany: (ids) =>
    set({
      selectedIds: [...ids],
      selectedId: ids.length > 0 ? ids[ids.length - 1] : null,
      lastEditMeta: null,
    }),
  selectAll: (frameId) =>
    set((s) => {
      const ids = Object.values(s.byId)
        .filter((a) => a.frameId === frameId)
        .map((a) => a.tempId);
      return {
        selectedIds: ids,
        selectedId: ids.length > 0 ? ids[ids.length - 1] : null,
        lastEditMeta: null,
      };
    }),
  clearSelection: () =>
    set({ selectedId: null, selectedIds: [], lastEditMeta: null }),
  reset: (initial) =>
    set((s) => {
      // Seed from server data first.
      const seed: Record<string, AnnotationDraft> = Object.fromEntries(
        initial.map((a) => [
          a.tempId,
          {
            ...a,
            status: a.status ?? "proposed",
            reviewedById: a.reviewedById ?? null,
            reviewedAt: a.reviewedAt ?? null,
            prevGeometry: a.prevGeometry ?? null,
          },
        ]),
      );
      const serverIdToSeedKey = new Map<string, string>();
      for (const [tempId, draft] of Object.entries(seed)) {
        if (draft.serverId) serverIdToSeedKey.set(draft.serverId, tempId);
      }
      // Build the merged map keeping each annotation under its LOCAL
      // tempId whenever a local entry already exists for it. Two
      // motivations:
      //
      //   - Unsaved edits (dirty drafts) must survive across asset
      //     switches and refetches; the local entry wins.
      //   - Clean entries that were just persisted have a server-side
      //     refresh waiting, but UI components (right-click context
      //     menu, ObjectsPanel rows, etc.) cached the original local
      //     tempId. Re-keying the entry under server.id silently
      //     breaks every cached reference — e.g. an open context-menu
      //     calling ``update(staleTempId, …)`` becomes a no-op after
      //     the autosave-driven refetch.
      const merged: Record<string, AnnotationDraft> = {};
      const consumedServerIds = new Set<string>();
      for (const local of Object.values(s.byId)) {
        if (local.serverId && serverIdToSeedKey.has(local.serverId)) {
          const seedKey = serverIdToSeedKey.get(local.serverId)!;
          const serverDraft = seed[seedKey];
          if (local.dirty) {
            // Unsaved edits win: keep local exactly as-is.
            merged[local.tempId] = local;
          } else {
            // Clean entry: hydrate fields from server but pin the
            // key to the existing local tempId.
            merged[local.tempId] = { ...serverDraft, tempId: local.tempId };
          }
          consumedServerIds.add(local.serverId);
        } else if (local.dirty && !local.serverId) {
          // Never-saved local create — preserve under its tempId
          // even if it doesn't appear in the server snapshot yet.
          merged[local.tempId] = local;
        }
        // Otherwise: clean + orphan (server deleted it, or it's a
        // different frame's data) → drop.
      }
      // Add server entries that weren't matched to any local draft.
      // Skip anything currently staged for server-side delete —
      // otherwise undo-staged deletes get visually re-hydrated by the
      // next refetch before the save round-trips the deletion.
      const stagedDeletes = new Set(s.pendingDeletes);
      for (const draft of Object.values(seed)) {
        if (draft.serverId && consumedServerIds.has(draft.serverId)) {
          continue;
        }
        if (draft.serverId && stagedDeletes.has(draft.serverId)) {
          continue;
        }
        merged[draft.tempId] = draft;
      }
      // Preserve the existing selection for any annotation that
      // survived the merge — otherwise an autosave-driven refetch
      // mid-flow would silently wipe the user's selection out from
      // under an open class palette or right-click menu (which
      // captures selectedIds at open time but reads it again when the
      // user clicks a class row).
      const survivingSelectedIds = s.selectedIds.filter(
        (id) => id in merged,
      );
      const survivingSelectedId =
        s.selectedId && s.selectedId in merged ? s.selectedId : null;
      return {
        byId: merged,
        selectedId: survivingSelectedId,
        selectedIds: survivingSelectedIds,
        // Preserve queued deletes — they survive frame switches so the
        // next save can flush them along with any preserved dirty
        // creates / updates above.
        pendingDeletes: s.pendingDeletes,
        lockedIds: new Set<string>(),
        clipboard: null,
        // Preserve history across same-scope refetches. The page-level
        // effect explicitly wipes it on asset/frame switch — clearing
        // it here made every autosave-triggered annotations refetch
        // erase the user's Cmd+Z stack.
        history: s.history,
        lastEditMeta: s.lastEditMeta,
      };
    }),
  discardLocal: () =>
    set(() => ({
      byId: {},
      selectedId: null,
      selectedIds: [],
      pendingDeletes: [],
      lockedIds: new Set<string>(),
      clipboard: null,
      history: { past: [], future: [] },
      lastEditMeta: null,
    })),
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
  setReviewState: (id, patch) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      // Review state is server-authoritative — do NOT flip ``dirty``.
      return {
        byId: { ...s.byId, [id]: { ...cur, ...patch } },
      };
    }),
  revertReviewState: (id, prev) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: { ...s.byId, [id]: { ...cur, ...prev } },
      };
    }),
  pushHistory: () => set((s) => ({ history: pushPast(s) })),
  undo: () =>
    set((s) => {
      if (s.history.past.length === 0) return s;
      const past = [...s.history.past];
      const last = past.pop()!;
      return {
        ...applyHistorySnapshot(s, last),
        history: { past, future: [...s.history.future, snapshot(s)] },
        lastEditMeta: null,
      };
    }),
  redo: () =>
    set((s) => {
      if (s.history.future.length === 0) return s;
      const future = [...s.history.future];
      const next = future.pop()!;
      return {
        ...applyHistorySnapshot(s, next),
        history: { past: [...s.history.past, snapshot(s)], future },
        lastEditMeta: null,
      };
    }),
  // ---- Plan 14 Phase 8 Task 6 ----
  isLocked: (id: string): boolean => get().lockedIds.has(id),
  lock: (id) =>
    set((s) => {
      if (s.lockedIds.has(id)) return s;
      const next = new Set(s.lockedIds);
      next.add(id);
      return { lockedIds: next };
    }),
  unlock: (id) =>
    set((s) => {
      if (!s.lockedIds.has(id)) return s;
      const next = new Set(s.lockedIds);
      next.delete(id);
      return { lockedIds: next };
    }),
  toggleLock: (id) =>
    set((s) => {
      const next = new Set(s.lockedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { lockedIds: next };
    }),
  duplicate: (id, dx = 16, dy = 16, imageBounds) => {
    const s0 = get();
    const cur = s0.byId[id];
    if (!cur) return null;
    const newId = `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shifted = shiftGeometry(cur.geometry, dx, dy, imageBounds);
    const draft: AnnotationDraft = {
      ...cur,
      tempId: newId,
      serverId: null,
      dirty: true,
      geometry: shifted,
      // Fresh proposed status — the duplicate is a NEW proposal.
      status: "proposed",
      reviewedById: null,
      reviewedAt: null,
      prevGeometry: null,
    };
    set((s) => ({
      byId: { ...s.byId, [newId]: draft },
      selectedId: newId,
      selectedIds: [newId],
      history: pushPast(s),
      lastEditMeta: null,
    }));
    return newId;
  },
  copyToClipboard: (id) =>
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        clipboard: {
          geometry: cur.geometry,
          classId: cur.classId,
          kind: cur.kind,
          colorOverride: cur.colorOverride ?? null,
        },
      };
    }),
  setActiveClassForSelected: (classId, ids) =>
    set((s) => {
      const targets = ids ?? s.selectedIds;
      const next = { ...s.byId };
      let changed = 0;
      for (const id of targets) {
        const draft = next[id];
        if (draft && draft.classId !== classId) {
          next[id] = { ...draft, classId, dirty: true };
          changed++;
        }
      }
      if (changed === 0) return s;
      return {
        byId: next,
        history: pushPast(s),
        lastEditMeta: null,
      };
    }),
  pasteFromClipboard: (atX, atY, frameId = null, imageBounds) => {
    const s0 = get();
    const cb = s0.clipboard;
    if (!cb) return null;
    const newId = `pst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const placed = placeGeometryAt(cb.geometry, atX, atY, imageBounds);
    const draft: AnnotationDraft = {
      tempId: newId,
      classId: cb.classId,
      kind: cb.kind,
      geometry: placed,
      frameId,
      serverId: null,
      dirty: true,
      status: "proposed",
      reviewedById: null,
      reviewedAt: null,
      prevGeometry: null,
      colorOverride: cb.colorOverride,
    };
    set((s) => ({
      byId: { ...s.byId, [newId]: draft },
      selectedId: newId,
      selectedIds: [newId],
      history: pushPast(s),
      lastEditMeta: null,
    }));
    return newId;
  },
}));

/**
 * Plan 14 Phase 8 Task 6 — translate a geometry by (dx, dy) and clamp
 * the result to ``imageBounds`` when provided. Mask + tag geometries are
 * returned unchanged (mask shifting requires RLE rewriting; tags have no
 * spatial position).
 */
function shiftGeometry(
  g: Geometry,
  dx: number,
  dy: number,
  bounds?: { w: number; h: number },
): Geometry {
  if (g.kind === "bbox") {
    const w = g.w;
    const h = g.h;
    let x = g.x + dx;
    let y = g.y + dy;
    if (bounds) {
      x = Math.max(0, Math.min(bounds.w - w, x));
      y = Math.max(0, Math.min(bounds.h - h, y));
    }
    return { kind: "bbox", x, y, w, h };
  }
  if (g.kind === "polygon") {
    const points = g.points.map(([px, py]) => {
      let nx = px + dx;
      let ny = py + dy;
      if (bounds) {
        nx = Math.max(0, Math.min(bounds.w, nx));
        ny = Math.max(0, Math.min(bounds.h, ny));
      }
      return [nx, ny] as [number, number];
    });
    return { kind: "polygon", points };
  }
  return g;
}

/**
 * Plan 14 Phase 8 Task 6 — re-anchor a geometry so its top-left lands at
 * (atX, atY). For polygons, the first vertex is anchored. Mask + tag
 * geometries are returned unchanged.
 */
function placeGeometryAt(
  g: Geometry,
  atX: number,
  atY: number,
  bounds?: { w: number; h: number },
): Geometry {
  if (g.kind === "bbox") {
    return shiftGeometry(g, atX - g.x, atY - g.y, bounds);
  }
  if (g.kind === "polygon" && g.points.length > 0) {
    const [ox, oy] = g.points[0];
    return shiftGeometry(g, atX - ox, atY - oy, bounds);
  }
  return g;
}

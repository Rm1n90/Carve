import { create } from "zustand";

/**
 * Plan-09 Phase 5 Task 4 — bridge slice between <ReviewPanel> and
 * <AnnotationCanvas> for the prev-revision compare overlay.
 *
 * Why a bridge slice (vs props): the canvas and review panel are
 * sibling components mounted independently. Rather than lift state up
 * through the editor page we mirror the ``samTrackBridge`` pattern:
 * the panel publishes the set of annotation ids whose ``prevGeometry``
 * the canvas should paint as a dashed/translucent overlay.
 *
 * Two sets:
 *   - ``hovered`` — transient. Mouse-enter on a review row adds; mouse-
 *     leave removes. Used to give the reviewer a quick "what was here
 *     before this edit" peek without committing a UI mode change.
 *   - ``pinned`` — sticky. The row's "Show prev" toggle adds; clicking
 *     again removes. Pinned overlays survive selection changes and
 *     hover changes; they only clear on explicit re-toggle or when the
 *     row leaves the panel (e.g. annotation deleted — handled by the
 *     panel via ``unpin`` on unmount of that row).
 *
 * Multiple rows may be pinned at once (compare two prev geometries
 * side-by-side).
 */
interface ReviewCompareState {
  hovered: Set<string>;
  pinned: Set<string>;
  setHover: (id: string, on: boolean) => void;
  togglePin: (id: string) => void;
  unpin: (id: string) => void;
  clear: () => void;
}

export const useReviewCompare = create<ReviewCompareState>((set) => ({
  hovered: new Set<string>(),
  pinned: new Set<string>(),
  setHover: (id, on) =>
    set((s) => {
      const next = new Set(s.hovered);
      if (on) next.add(id);
      else next.delete(id);
      return { hovered: next };
    }),
  togglePin: (id) =>
    set((s) => {
      const next = new Set(s.pinned);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { pinned: next };
    }),
  unpin: (id) =>
    set((s) => {
      if (!s.pinned.has(id)) return s;
      const next = new Set(s.pinned);
      next.delete(id);
      return { pinned: next };
    }),
  clear: () => set({ hovered: new Set(), pinned: new Set() }),
}));

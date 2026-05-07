// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

/**
 * v3.6 — bridge slice connecting <SamTrackPanel> and <AnnotationCanvas>
 * for canvas-click teach-back of tracking-object prompts.
 *
 * Why a slice and not props: <AnnotationCanvas> is mounted independently
 * of <SamTrackPanel> (the panel is a sibling on the right rail) and has
 * no direct ref to the panel's TrackPropagateTool instance. Rather than
 * lift the tool up to AnnotateAssetPage we expose a tiny pub/sub:
 *
 *   - The panel registers an ``onCanvasClick`` callback while it's
 *     mounted in track mode. The callback receives image-space click
 *     coordinates and is responsible for auto-starting the session
 *     (if needed) and calling ``addObjectAtFrame`` with the click as
 *     the positive prompt.
 *
 *   - The panel publishes a ``markers`` array — one entry per registered
 *     tracking object — that the canvas reads to paint numbered point
 *     markers on the overlay layer (CVAT-style teach-back UX).
 *
 *   - On unmount / discard, the panel calls ``clear()`` to release the
 *     handler and wipe the markers.
 */

export interface SamTrackMarker {
  /** obj_id assigned by the server (1, 2, 3 ...). */
  objId: number;
  /** Image-space x of the click. */
  x: number;
  /** Image-space y of the click. */
  y: number;
  /** v3.27.12 — 1 = positive (left-click, painted GREEN);
   *  0 = negative (right-click, painted RED). The canvas uses this
   *  to colour the marker so the user sees their own prompts. */
  label: 0 | 1;
  /** v3.27.12 — frame_id (string) the click belongs to. The canvas
   *  filters markers by ``frameId === currentFrameId`` so prompts on
   *  other frames don't pollute the active overlay. */
  frameId: string | null;
}

// v3.27.5 — second arg ``negative`` flags right-click as a NEGATIVE
// point prompt (label=0). Renamed from the prior ``alt``-keyed convention
// because right-click is the standard segmentation tool gesture for
// negative refinement (CVAT, SAM-2 demo UI, COCO Annotator).
export type SamTrackClickHandler = (
  point: [number, number],
  negative?: boolean,
) => void;
/** v3.8 Phase 4-video step F7 — bbox seed in track mode. The canvas
 * publishes the drag rectangle (image-space xyxy) and the panel calls
 * ``addObjectAtFrame`` with ``boxes=[[x1,y1,x2,y2]]`` and empty points. */
export type SamTrackBoxHandler = (
  box: [number, number, number, number],
) => void;

interface SamTrackBridgeState {
  onCanvasClick: SamTrackClickHandler | null;
  onCanvasBox: SamTrackBoxHandler | null;
  markers: SamTrackMarker[];
  setHandler: (handler: SamTrackClickHandler | null) => void;
  setBoxHandler: (handler: SamTrackBoxHandler | null) => void;
  setMarkers: (markers: SamTrackMarker[]) => void;
  /** v3.27.12 — append a single marker. Used by TrackTool.clickAt to
   *  paint a green/red dot at the click point so the user sees the
   *  prompt they just placed. */
  pushMarker: (marker: SamTrackMarker) => void;
  /** v3.27.12 — drop every marker for ``frameId``. Called when the
   *  user removes an object or discards the session so stale dots
   *  don't linger on frames where the obj no longer exists. */
  clearMarkersForFrame: (frameId: string | null) => void;
  clear: () => void;
}

export const useSamTrackBridge = create<SamTrackBridgeState>((set) => ({
  onCanvasClick: null,
  onCanvasBox: null,
  markers: [],
  setHandler: (handler) => set({ onCanvasClick: handler }),
  setBoxHandler: (handler) => set({ onCanvasBox: handler }),
  setMarkers: (markers) => set({ markers }),
  pushMarker: (marker) =>
    set((s) => ({ markers: [...s.markers, marker] })),
  clearMarkersForFrame: (frameId) =>
    set((s) => ({ markers: s.markers.filter((m) => m.frameId !== frameId) })),
  clear: () => set({ onCanvasClick: null, onCanvasBox: null, markers: [] }),
}));

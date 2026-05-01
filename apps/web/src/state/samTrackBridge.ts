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
  /** Image-space x of the original positive click. */
  x: number;
  /** Image-space y of the original positive click. */
  y: number;
}

export type SamTrackClickHandler = (point: [number, number]) => void;
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
  clear: () => void;
}

export const useSamTrackBridge = create<SamTrackBridgeState>((set) => ({
  onCanvasClick: null,
  onCanvasBox: null,
  markers: [],
  setHandler: (handler) => set({ onCanvasClick: handler }),
  setBoxHandler: (handler) => set({ onCanvasBox: handler }),
  setMarkers: (markers) => set({ markers }),
  clear: () => set({ onCanvasClick: null, onCanvasBox: null, markers: [] }),
}));

// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

import type { SamMode } from "@/canvas/tools/SamTool";

export type ToolName = "cursor" | "bbox" | "polygon" | "mask" | "tag" | "sam";

export interface VisibilityFlags {
  annotations: boolean;
  labels: boolean;
  pixels: boolean;
  crosshairs: boolean;
  thumbnails: boolean;
}

interface ToolState {
  active: ToolName;
  activeClassId: string | null;
  autoApply: boolean;
  visibility: VisibilityFlags;
  hoveredAnnotationId: string | null;
  /** Brush radius for the mask tool (px in image space). 5/10/25/50/100 px
   * presets in the toolbar. The MaskBrushTool reads this on construction
   * and via a live store subscription. */
  maskBrushRadius: number;
  /**
   * Plan 09 Task 11 — mask brush hardness (0..1). ``1.0`` reproduces
   * the legacy solid-disc brush (entire radius is uniform alpha).
   * ``< 1.0`` keeps an inner solid core of ``radius * hardness`` and
   * linearly ramps alpha from 1→0 across the outer falloff band.
   * Default ``0.7`` gives a slight feathered edge that matches modern
   * brush UX.
   */
  maskHardness: number;
  /**
   * Plan 09 Task 11 — explicit eraser toggle in the toolbar. When
   * ``true``, left-click painting subtracts from the mask. Right-click
   * is still always erase regardless of this flag.
   */
  maskEraser: boolean;
  /**
   * v3.5 Phase D — input modality for the SAM tool. ``point`` is the
   * legacy click-driven flow (SAM 2 + SAM 3); ``box`` and ``text`` are
   * SAM 3 one-shot prompts. The toolbar's mode chips and the canvas's
   * pointer/text handlers both read this so the UI and the SamTool
   * instance stay in sync without prop-drilling.
   */
  samMode: SamMode;
  setActive: (t: ToolName) => void;
  setActiveClassId: (id: string | null) => void;
  setAutoApply: (v: boolean) => void;
  toggleAutoApply: () => void;
  setVisibility: (key: keyof VisibilityFlags, value: boolean) => void;
  setHoveredAnnotationId: (id: string | null) => void;
  setMaskBrushRadius: (r: number) => void;
  setMaskHardness: (h: number) => void;
  setMaskEraser: (v: boolean) => void;
  toggleMaskEraser: () => void;
  setSamMode: (m: SamMode) => void;
}

const DEFAULT_VISIBILITY: VisibilityFlags = {
  annotations: true,
  labels: true,
  pixels: true,
  crosshairs: false,
  // Thumbnails are on by default in v2.1 so users can navigate between assets
  // without needing to discover the visibility menu. See audit bug 3 / D.
  thumbnails: true,
};

export const useTool = create<ToolState>((set) => ({
  active: "cursor",
  activeClassId: null,
  autoApply: false,
  visibility: DEFAULT_VISIBILITY,
  hoveredAnnotationId: null,
  maskBrushRadius: 25,
  maskHardness: 0.7,
  maskEraser: false,
  samMode: "point",
  setActive: (t) => set({ active: t }),
  setActiveClassId: (id) => set({ activeClassId: id }),
  setAutoApply: (v) => set({ autoApply: v }),
  toggleAutoApply: () => set((s) => ({ autoApply: !s.autoApply })),
  setVisibility: (key, value) =>
    set((s) => ({ visibility: { ...s.visibility, [key]: value } })),
  setHoveredAnnotationId: (id) => set({ hoveredAnnotationId: id }),
  setMaskBrushRadius: (r) =>
    set({ maskBrushRadius: Math.max(1, Math.min(200, Math.round(r))) }),
  setMaskHardness: (h) => {
    const v = Number.isFinite(h) ? h : 0.7;
    set({ maskHardness: Math.max(0, Math.min(1, v)) });
  },
  setMaskEraser: (v) => set({ maskEraser: !!v }),
  toggleMaskEraser: () => set((s) => ({ maskEraser: !s.maskEraser })),
  setSamMode: (m) => set({ samMode: m }),
}));

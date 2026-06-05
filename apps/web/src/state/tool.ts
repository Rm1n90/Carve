// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";

import type { SamMode } from "@/canvas/tools/SamTool";
import type { ClipboardEntry } from "@/state/annotations";

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
  /**
   * F4 — streak indicator. Tracks how many consecutive annotations
   * the user has drawn with the SAME class via a *drawing tool*
   * (Bbox, Polygon, Mask, SAM commit, Tag). Programmatic additions
   * (paste, copy-from-prev, SAM batch, YOLO predict) do NOT touch
   * the counter — they shouldn't reward the user for autopilot.
   *
   * Volatile; never persisted. Resets on project / task switch
   * because the editor remounts (zustand instance is the same but
   * tools call ``resetStreak`` from their cleanup).
   */
  lastDrawClassId: string | null;
  streakCount: number;
  /**
   * CVAT-style floating paste. When non-null the editor is "placing" a
   * copied selection: the canvas renders a translucent ghost of these
   * entries following the cursor, and a left-click commits them at the
   * pointer (right-click / Esc / tool-switch cancels). Holds a SNAPSHOT
   * of the clipboard taken at Ctrl+V time so a later Ctrl+C can't change
   * what is mid-placement. Transient — never persisted.
   */
  pastePlacement: ClipboardEntry[] | null;
  setActive: (t: ToolName) => void;
  setActiveClassId: (id: string | null) => void;
  /**
   * Tools call this AFTER a successful create. If ``classId`` matches
   * the prior ``lastDrawClassId`` the counter ticks up; otherwise it
   * resets to 1 and ``lastDrawClassId`` becomes the new class. ``null``
   * is a no-op (defensive — tools should always pass a real id).
   */
  recordDraw: (classId: string | null) => void;
  /** Wipe the streak — used on class delete / asset switch. */
  resetStreak: () => void;
  setAutoApply: (v: boolean) => void;
  toggleAutoApply: () => void;
  setVisibility: (key: keyof VisibilityFlags, value: boolean) => void;
  setHoveredAnnotationId: (id: string | null) => void;
  setMaskBrushRadius: (r: number) => void;
  setMaskHardness: (h: number) => void;
  setMaskEraser: (v: boolean) => void;
  toggleMaskEraser: () => void;
  setSamMode: (m: SamMode) => void;
  /** Arm floating-paste placement with a clipboard snapshot. */
  startPastePlacement: (entries: ClipboardEntry[]) => void;
  /** Disarm floating-paste placement (commit, cancel, or tool switch). */
  cancelPastePlacement: () => void;
}

const DEFAULT_VISIBILITY: VisibilityFlags = {
  annotations: true,
  labels: true,
  pixels: true,
  // Crosshair guide is on by default (CVAT / Ultralytics parity) so
  // users get pixel-precise bbox alignment without discovering the
  // visibility menu. They can still toggle it off there.
  crosshairs: true,
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
  lastDrawClassId: null,
  streakCount: 0,
  pastePlacement: null,
  // Switching tools cancels an in-flight floating paste so the ghost
  // never lingers under a different tool.
  setActive: (t) => set({ active: t, pastePlacement: null }),
  setActiveClassId: (id) => set({ activeClassId: id }),
  recordDraw: (classId) => {
    if (!classId) return;
    set((s) => {
      if (s.lastDrawClassId === classId) {
        return { streakCount: s.streakCount + 1 };
      }
      return { lastDrawClassId: classId, streakCount: 1 };
    });
  },
  resetStreak: () => set({ lastDrawClassId: null, streakCount: 0 }),
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
  startPastePlacement: (entries) =>
    set({ pastePlacement: entries.length > 0 ? entries : null }),
  cancelPastePlacement: () => set({ pastePlacement: null }),
}));

import { create } from "zustand";

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
  setActive: (t: ToolName) => void;
  setActiveClassId: (id: string | null) => void;
  setAutoApply: (v: boolean) => void;
  toggleAutoApply: () => void;
  setVisibility: (key: keyof VisibilityFlags, value: boolean) => void;
  setHoveredAnnotationId: (id: string | null) => void;
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
  setActive: (t) => set({ active: t }),
  setActiveClassId: (id) => set({ activeClassId: id }),
  setAutoApply: (v) => set({ autoApply: v }),
  toggleAutoApply: () => set((s) => ({ autoApply: !s.autoApply })),
  setVisibility: (key, value) =>
    set((s) => ({ visibility: { ...s.visibility, [key]: value } })),
  setHoveredAnnotationId: (id) => set({ hoveredAnnotationId: id }),
}));

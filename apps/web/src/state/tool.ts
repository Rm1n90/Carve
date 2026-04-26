import { create } from "zustand";

export type ToolName = "cursor" | "bbox" | "polygon" | "mask" | "tag" | "sam";

interface ToolState {
  active: ToolName;
  activeClassId: string | null;
  setActive: (t: ToolName) => void;
  setActiveClassId: (id: string | null) => void;
}

export const useTool = create<ToolState>((set) => ({
  active: "cursor",
  activeClassId: null,
  setActive: (t) => set({ active: t }),
  setActiveClassId: (id) => set({ activeClassId: id }),
}));

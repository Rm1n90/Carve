// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * v3.30 — per-task persistence for the Auto-Annotate and Smart Find
 * dialogs. Without this, every Run wiped the user's setup the moment
 * the dialog closed; reopening showed an empty form. Now the last
 * configuration is hydrated when the user reopens the same task's
 * dialog, and an explicit ``Clear`` button resets everything for that
 * task.
 *
 * Scope is per-task (not per-project) so different tasks in the same
 * project can have different prompt set-ups without bleeding into
 * each other. Persistence lives in ``localStorage`` under
 * ``carve-dialog-prefs``.
 *
 * Visual-mode picks are intentionally NOT persisted — they reference
 * concrete frame / annotation ids that may have been deleted between
 * sessions. Text-mode rows, sliders, scope and toggles ARE persisted
 * because they are stable across sessions.
 */
export interface AutoAnnotateTextConfig {
  rows: Array<{ classId: string; prompt: string }>;
  threshold: number;
  findAll: boolean;
  overwrite: boolean;
  samPostMode: "off" | "to-bbox";
  scope: "this" | "all";
  useVlmFo1: boolean;
  // Bbox-IoU floor for the per-class NMS dedup pass on the server.
  // Optional so older localStorage entries (saved before this field
  // existed) still load — the dialog falls back to a sensible default
  // when missing.
  iouThreshold?: number;
}

export interface SmartFindModeCommonConfig {
  conf: number;
  iou: number;
  outputKind: string;
  overwrite: boolean;
  scope: "this" | "all";
}

export interface SmartFindTextConfig extends SmartFindModeCommonConfig {
  rows: Array<{ classId: string; prompt: string }>;
}

export interface SmartFindPromptFreeConfig extends SmartFindModeCommonConfig {
  classId: string;
  maxDet: number;
}

export interface SmartFindConfig {
  mode?: "text" | "visual" | "prompt_free";
  text?: SmartFindTextConfig;
  prompt_free?: SmartFindPromptFreeConfig;
  visual_common?: SmartFindModeCommonConfig;
}

export interface DialogPrefsState {
  autoAnnotateByTask: Record<string, { text?: AutoAnnotateTextConfig }>;
  smartFindByTask: Record<string, SmartFindConfig>;

  getAutoAnnotate: (
    taskId: string | undefined,
  ) => { text?: AutoAnnotateTextConfig } | undefined;
  saveAutoAnnotate: (
    taskId: string | undefined,
    patch: { text?: AutoAnnotateTextConfig },
  ) => void;
  clearAutoAnnotate: (taskId: string | undefined) => void;

  getSmartFind: (taskId: string | undefined) => SmartFindConfig | undefined;
  saveSmartFind: (
    taskId: string | undefined,
    patch: Partial<SmartFindConfig>,
  ) => void;
  clearSmartFind: (taskId: string | undefined) => void;
}

export const useDialogPrefs = create<DialogPrefsState>()(
  persist(
    (set, get) => ({
      autoAnnotateByTask: {},
      smartFindByTask: {},

      getAutoAnnotate: (taskId) => {
        if (!taskId) return undefined;
        return get().autoAnnotateByTask[taskId];
      },
      saveAutoAnnotate: (taskId, patch) => {
        if (!taskId) return;
        set((s) => ({
          ...s,
          autoAnnotateByTask: {
            ...s.autoAnnotateByTask,
            [taskId]: { ...(s.autoAnnotateByTask[taskId] ?? {}), ...patch },
          },
        }));
      },
      clearAutoAnnotate: (taskId) => {
        if (!taskId) return;
        set((s) => {
          if (!(taskId in s.autoAnnotateByTask)) return s;
          const next = { ...s.autoAnnotateByTask };
          delete next[taskId];
          return { ...s, autoAnnotateByTask: next };
        });
      },

      getSmartFind: (taskId) => {
        if (!taskId) return undefined;
        return get().smartFindByTask[taskId];
      },
      saveSmartFind: (taskId, patch) => {
        if (!taskId) return;
        set((s) => ({
          ...s,
          smartFindByTask: {
            ...s.smartFindByTask,
            [taskId]: { ...(s.smartFindByTask[taskId] ?? {}), ...patch },
          },
        }));
      },
      clearSmartFind: (taskId) => {
        if (!taskId) return;
        set((s) => {
          if (!(taskId in s.smartFindByTask)) return s;
          const next = { ...s.smartFindByTask };
          delete next[taskId];
          return { ...s, smartFindByTask: next };
        });
      },
    }),
    {
      name: "carve-dialog-prefs",
      storage: createJSONStorage(() => localStorage),
      version: 1,
    },
  ),
);

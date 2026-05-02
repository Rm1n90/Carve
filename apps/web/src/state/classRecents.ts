// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Plan 14 Phase 8 Task 4 — pinned + recent class ids per project. Drives
 * the Class Command Palette's "Pinned" / "Recent" tabs and the right-rail
 * `ClassesPanel` "Pinned" group.
 *
 * Persistence: localStorage under ``carve-class-recents``. Per-project
 * scoping means switching projects doesn't leak the previous project's
 * top-of-mind classes into the new one's palette.
 */
const RECENT_CAP = 8;

export interface ClassRecentsState {
  pinnedByProject: Record<string, string[]>;
  recentByProject: Record<string, string[]>;
  isPinned: (projectId: string, classId: string) => boolean;
  pin: (projectId: string, classId: string) => void;
  unpin: (projectId: string, classId: string) => void;
  togglePin: (projectId: string, classId: string) => void;
  /** Pushes ``classId`` to the front of the recent list, dedupes, caps at 8. */
  recordUse: (projectId: string, classId: string) => void;
  getPinned: (projectId: string) => string[];
  getRecent: (projectId: string) => string[];
}

export const useClassRecents = create<ClassRecentsState>()(
  persist(
    (set, get) => ({
      pinnedByProject: {},
      recentByProject: {},
      isPinned: (pid, cid) => (get().pinnedByProject[pid] ?? []).includes(cid),
      pin: (pid, cid) =>
        set((s) => {
          const current = s.pinnedByProject[pid] ?? [];
          if (current.includes(cid)) return s;
          return {
            ...s,
            pinnedByProject: {
              ...s.pinnedByProject,
              [pid]: [...current, cid],
            },
          };
        }),
      unpin: (pid, cid) =>
        set((s) => {
          const current = s.pinnedByProject[pid] ?? [];
          if (!current.includes(cid)) return s;
          return {
            ...s,
            pinnedByProject: {
              ...s.pinnedByProject,
              [pid]: current.filter((x) => x !== cid),
            },
          };
        }),
      togglePin: (pid, cid) => {
        const isPinned = get().isPinned(pid, cid);
        if (isPinned) get().unpin(pid, cid);
        else get().pin(pid, cid);
      },
      recordUse: (pid, cid) =>
        set((s) => {
          const current = s.recentByProject[pid] ?? [];
          const without = current.filter((x) => x !== cid);
          const next = [cid, ...without].slice(0, RECENT_CAP);
          return {
            ...s,
            recentByProject: {
              ...s.recentByProject,
              [pid]: next,
            },
          };
        }),
      getPinned: (pid) => get().pinnedByProject[pid] ?? [],
      getRecent: (pid) => get().recentByProject[pid] ?? [],
    }),
    {
      name: "carve-class-recents",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

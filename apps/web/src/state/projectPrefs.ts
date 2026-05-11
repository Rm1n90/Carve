// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Plan 14 Phase 8 Task 1 — per-user project navigation preferences.
 *
 * Tracks:
 *   - ``pinnedProjectIds`` — explicitly starred projects, surfaced via the
 *     "Pinned" filter chip on the projects index.
 *   - ``recentProjectIds`` — most-recent-first list of project ids the
 *     user has visited; capped at ``RECENT_CAP``. The detail page calls
 *     ``recordVisit`` on mount so navigating into a project bumps it to
 *     the top of the list.
 *
 * Persistence: localStorage under ``carve-project-prefs``.
 *
 * The pinned set is stored as an array on disk (JSON has no Set) but the
 * runtime exposes ``Set<string>`` via ``getPinnedSet`` so callers can do
 * O(1) membership checks without rebuilding it on every render.
 */
const RECENT_CAP = 5;
const RECENT_TASKS_PER_PROJECT_CAP = 10;

export interface ProjectPrefsState {
  pinnedProjectIds: string[];
  recentProjectIds: string[];
  /**
   * v3.30 — most-recent-first task visit history, scoped per project.
   * Drives the project detail page's "Resume" CTA so the button
   * targets the task the user was last working in, not just the
   * newest task by ``created_at``. Visits are recorded on
   * AnnotateAssetPage mount.
   */
  recentTaskIdsByProject: Record<string, string[]>;
  isPinned: (projectId: string) => boolean;
  togglePin: (projectId: string) => void;
  recordVisit: (projectId: string) => void;
  recordTaskVisit: (projectId: string, taskId: string) => void;
  getRecentTasks: (projectId: string) => string[];
  getPinnedSet: () => Set<string>;
}

export const useProjectPrefs = create<ProjectPrefsState>()(
  persist(
    (set, get) => ({
      pinnedProjectIds: [],
      recentProjectIds: [],
      recentTaskIdsByProject: {},
      isPinned: (projectId) => get().pinnedProjectIds.includes(projectId),
      togglePin: (projectId) =>
        set((s) => {
          const has = s.pinnedProjectIds.includes(projectId);
          return {
            ...s,
            pinnedProjectIds: has
              ? s.pinnedProjectIds.filter((x) => x !== projectId)
              : [...s.pinnedProjectIds, projectId],
          };
        }),
      recordVisit: (projectId) =>
        set((s) => {
          const without = s.recentProjectIds.filter((x) => x !== projectId);
          return {
            ...s,
            recentProjectIds: [projectId, ...without].slice(0, RECENT_CAP),
          };
        }),
      recordTaskVisit: (projectId, taskId) =>
        set((s) => {
          const existing = s.recentTaskIdsByProject[projectId] ?? [];
          const without = existing.filter((x) => x !== taskId);
          const next = [taskId, ...without].slice(
            0,
            RECENT_TASKS_PER_PROJECT_CAP,
          );
          return {
            ...s,
            recentTaskIdsByProject: {
              ...s.recentTaskIdsByProject,
              [projectId]: next,
            },
          };
        }),
      getRecentTasks: (projectId) =>
        get().recentTaskIdsByProject[projectId] ?? [],
      getPinnedSet: () => new Set(get().pinnedProjectIds),
    }),
    {
      name: "carve-project-prefs",
      storage: createJSONStorage(() => localStorage),
      version: 2,
    },
  ),
);

// Armin Mehri — mehri.armin@gmail.com
import { create } from "zustand";
import type { FilterGroup, ScoreThresholds } from "@/lib/annotation-filter";

interface State {
  /**
   * Active filter tree. `null` means no filter — callers treat that
   * as "show everything" without walking any predicate logic.
   */
  filter: FilterGroup | null;
  setFilter: (filter: FilterGroup | null) => void;
  clearFilter: () => void;
  /**
   * Score thresholds being previewed by the Logo AI filter, or `null`.
   * Boxes under them are hidden the same way filtered-out ones are.
   */
  scorePreview: ScoreThresholds | null;
  setScorePreview: (thresholds: ScoreThresholds | null) => void;
  /**
   * Keep every annotation on the matching images in view. The filter
   * then only picks the images the arrow keys stop on. Remembered in
   * this browser.
   */
  showAll: boolean;
  setShowAll: (showAll: boolean) => void;
}

const SHOW_ALL_KEY = "carve:filter-show-all";

function readShowAll(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch {
    return false;
  }
}

export const useFilter = create<State>((set) => ({
  filter: null,
  setFilter: (filter) => set({ filter }),
  clearFilter: () => set({ filter: null }),
  scorePreview: null,
  setScorePreview: (scorePreview) => set({ scorePreview }),
  showAll: readShowAll(),
  setShowAll: (showAll) => {
    try {
      window.localStorage.setItem(SHOW_ALL_KEY, showAll ? "1" : "0");
    } catch {
      /* the choice still holds for this session */
    }
    set({ showAll });
  },
}));

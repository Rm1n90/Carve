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
}

export const useFilter = create<State>((set) => ({
  filter: null,
  setFilter: (filter) => set({ filter }),
  clearFilter: () => set({ filter: null }),
  scorePreview: null,
  setScorePreview: (scorePreview) => set({ scorePreview }),
}));

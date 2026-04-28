import { create } from "zustand";
import type { FilterGroup } from "@/lib/annotation-filter";

interface State {
  /**
   * Active filter tree. `null` means no filter — callers treat that
   * as "show everything" without walking any predicate logic.
   */
  filter: FilterGroup | null;
  setFilter: (filter: FilterGroup | null) => void;
  clearFilter: () => void;
}

export const useFilter = create<State>((set) => ({
  filter: null,
  setFilter: (filter) => set({ filter }),
  clearFilter: () => set({ filter: null }),
}));

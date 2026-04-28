import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { FilterBuilderDialog } from "@/components/annotation/FilterBuilderDialog";
import { useFilter } from "@/state/annotationFilter";
import type { FilterGroup, FilterRule } from "@/lib/annotation-filter";
import { isFilterGroup } from "@/lib/annotation-filter";

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" data-testid="harness-open" onClick={() => setOpen(true)}>
        Open
      </button>
      <FilterBuilderDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

beforeEach(() => {
  useFilter.getState().clearFilter();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("FilterBuilderDialog — open/submit/cancel", () => {
  it("opens with one empty group containing one empty rule", () => {
    render(<Harness />);
    expect(screen.getByText("Filter annotations")).toBeInTheDocument();
    const rows = screen.getAllByTestId("filter-rule-row");
    expect(rows).toHaveLength(1);
  });

  it("Submit applies the filter to the store", () => {
    render(<Harness />);
    // Fill in the value field on the first (empty) rule.
    const valueInput = screen.getAllByTestId("filter-rule-value")[0];
    fireEvent.change(valueInput, { target: { value: "car" } });

    fireEvent.click(screen.getByTestId("filter-submit"));

    const applied = useFilter.getState().filter;
    expect(applied).not.toBeNull();
    expect(applied?.combinator).toBe("AND");
    expect(applied?.rules).toHaveLength(1);
    const firstRule = applied!.rules[0] as FilterRule;
    expect(firstRule.field).toBe("label");
    expect(firstRule.op).toBe("==");
    expect(firstRule.value).toBe("car");
    expect(firstRule.not).toBe(false);
  });

  it("Submit with NOT toggle persists the negation", () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByTestId("filter-rule-not")[0]);
    fireEvent.change(screen.getAllByTestId("filter-rule-value")[0], {
      target: { value: "dog" },
    });
    fireEvent.click(screen.getByTestId("filter-submit"));

    const applied = useFilter.getState().filter;
    expect(applied).not.toBeNull();
    const rule = applied!.rules[0] as FilterRule;
    expect(rule.not).toBe(true);
    expect(rule.value).toBe("dog");
  });

  it("Cancel does not update the store", () => {
    // Pre-seed the store so we can assert it's unchanged.
    const seeded: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "seed" }],
    };
    useFilter.getState().setFilter(seeded);

    render(<Harness />);
    // Type something different that we'd expect to NOT be persisted.
    fireEvent.change(screen.getAllByTestId("filter-rule-value")[0], {
      target: { value: "should-not-persist" },
    });

    fireEvent.click(screen.getByTestId("filter-cancel"));

    // Store still equals the seeded filter.
    const after = useFilter.getState().filter;
    expect(after).toEqual(seeded);
  });
});

describe("FilterBuilderDialog — Clear filters", () => {
  it("'Clear filters' resets the working tree to one empty rule", () => {
    render(<Harness />);
    // Seed the working tree by adding extra rules.
    fireEvent.click(screen.getAllByTestId("filter-add-rule")[0]);
    fireEvent.click(screen.getAllByTestId("filter-add-rule")[0]);
    expect(screen.getAllByTestId("filter-rule-row")).toHaveLength(3);

    fireEvent.click(screen.getByTestId("filter-clear"));

    // Tree resets to one empty rule.
    expect(screen.getAllByTestId("filter-rule-row")).toHaveLength(1);
    const valueInput = screen.getAllByTestId(
      "filter-rule-value",
    )[0] as HTMLInputElement;
    expect(valueInput.value).toBe("");
  });
});

describe("FilterBuilderDialog — Add rule / Add group", () => {
  it("'+ Add rule' appends another rule to the root group", () => {
    render(<Harness />);
    expect(screen.getAllByTestId("filter-rule-row")).toHaveLength(1);

    fireEvent.click(screen.getAllByTestId("filter-add-rule")[0]);

    expect(screen.getAllByTestId("filter-rule-row")).toHaveLength(2);
  });

  it("'+ Add group' nests a sub-group with one rule inside", () => {
    render(<Harness />);
    expect(screen.getAllByTestId("filter-group")).toHaveLength(1);

    fireEvent.click(screen.getAllByTestId("filter-add-group")[0]);

    // Root + nested group.
    expect(screen.getAllByTestId("filter-group")).toHaveLength(2);
    // Two rule rows: the original empty one + the nested group's empty rule.
    expect(screen.getAllByTestId("filter-rule-row")).toHaveLength(2);
  });

  it("submitting an empty filter clears the store", () => {
    // Pre-seed a filter so we can verify Submit-with-empty clears it.
    useFilter
      .getState()
      .setFilter({
        combinator: "AND",
        rules: [{ not: false, field: "label", op: "==", value: "x" }],
      });
    render(<Harness />);
    // The dialog seeds from the active filter — clear it back to empty
    // by clicking "Clear filters" first.
    fireEvent.click(screen.getByTestId("filter-clear"));
    fireEvent.click(screen.getByTestId("filter-submit"));

    expect(useFilter.getState().filter).toBeNull();
  });
});

describe("FilterBuilderDialog — recently used persistence", () => {
  it("Submit writes the filter to localStorage under carve.filters.recent.v1", () => {
    render(<Harness />);
    fireEvent.change(screen.getAllByTestId("filter-rule-value")[0], {
      target: { value: "truck" },
    });
    fireEvent.click(screen.getByTestId("filter-submit"));

    const raw = window.localStorage.getItem("carve.filters.recent.v1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as FilterGroup[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const head = parsed[0];
    expect(isFilterGroup(head)).toBe(true);
    const rule = head.rules[0] as FilterRule;
    expect(rule.value).toBe("truck");
  });

  it("Recent list is capped at 5 entries", () => {
    // Seed 6 distinct filters via direct localStorage writes to simulate
    // multiple submissions, then verify the dialog trims down to 5 on the
    // next submit.
    const six: FilterGroup[] = Array.from({ length: 6 }, (_, i) => ({
      combinator: "AND" as const,
      rules: [
        { not: false, field: "label" as const, op: "==" as const, value: `v${i}` },
      ],
    }));
    window.localStorage.setItem(
      "carve.filters.recent.v1",
      JSON.stringify(six),
    );

    render(<Harness />);
    fireEvent.change(screen.getAllByTestId("filter-rule-value")[0], {
      target: { value: "newest" },
    });
    fireEvent.click(screen.getByTestId("filter-submit"));

    const parsed = JSON.parse(
      window.localStorage.getItem("carve.filters.recent.v1")!,
    ) as FilterGroup[];
    expect(parsed.length).toBe(5);
    // Newest goes to the front.
    const head = parsed[0].rules[0] as FilterRule;
    expect(head.value).toBe("newest");
  });
});

describe("FilterBuilderDialog — combinator toggle", () => {
  it("clicking OR switches the group combinator", () => {
    render(<Harness />);
    const groups = screen.getAllByTestId("filter-group");
    const root = groups[0];

    const orBtn = within(root).getByTestId("filter-group-combinator-OR");
    fireEvent.click(orBtn);
    fireEvent.change(screen.getAllByTestId("filter-rule-value")[0], {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("filter-submit"));

    const applied = useFilter.getState().filter;
    expect(applied?.combinator).toBe("OR");
  });
});

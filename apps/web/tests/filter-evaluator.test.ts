import { describe, expect, it } from "vitest";
import {
  evaluateFilter,
  hasMeaningfulRules,
  type FilterGroup,
} from "@/lib/annotation-filter";
import type { AnnotationDraft } from "@/state/annotations";
import type { ClassRow } from "@/api/classes";

function classRow(id: string, name: string): ClassRow {
  return {
    id,
    project_id: "p-1",
    idx: 0,
    name,
    color: "#aabbcc",
    attributes: {},
    created_at: "2024-01-01T00:00:00Z",
  };
}

const CLASSES: Record<string, ClassRow> = {
  "c-car": classRow("c-car", "car"),
  "c-dog": classRow("c-dog", "dog"),
  "c-cat": classRow("c-cat", "cat"),
};

function bbox(
  tempId: string,
  classId: string,
  x: number,
  y: number,
  w: number,
  h: number,
): AnnotationDraft {
  return {
    tempId,
    classId,
    kind: "bbox",
    geometry: { kind: "bbox", x, y, w, h },
    frameId: null,
    serverId: null,
    dirty: false,
  };
}

describe("evaluateFilter — single rule", () => {
  it("'label == car' matches car annotations only", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "car" }],
    };
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    const dog = bbox("a-2", "c-dog", 0, 0, 10, 10);

    expect(evaluateFilter(car, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(dog, CLASSES, filter)).toBe(false);
  });

  it("'NOT label == car' matches non-car annotations", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: true, field: "label", op: "==", value: "car" }],
    };
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    const dog = bbox("a-2", "c-dog", 0, 0, 10, 10);

    expect(evaluateFilter(car, CLASSES, filter)).toBe(false);
    expect(evaluateFilter(dog, CLASSES, filter)).toBe(true);
  });

  it("numeric width '> 50' matches large bboxes only", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "width", op: ">", value: 50 }],
    };
    const small = bbox("a-1", "c-car", 0, 0, 10, 10);
    const large = bbox("a-2", "c-car", 0, 0, 100, 100);

    expect(evaluateFilter(small, CLASSES, filter)).toBe(false);
    expect(evaluateFilter(large, CLASSES, filter)).toBe(true);
  });

  it("'kind == bbox' filters by geometry kind", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "kind", op: "==", value: "bbox" }],
    };
    const box = bbox("a-1", "c-car", 0, 0, 10, 10);
    const polygon: AnnotationDraft = {
      tempId: "a-2",
      classId: "c-car",
      kind: "polygon",
      geometry: { kind: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
      frameId: null,
      serverId: null,
      dirty: false,
    };

    expect(evaluateFilter(box, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(polygon, CLASSES, filter)).toBe(false);
  });

  it("obj_id falls back to tempId when serverId is null", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "obj_id", op: "==", value: "a-1" }],
    };
    const a = bbox("a-1", "c-car", 0, 0, 10, 10);
    const b = bbox("a-2", "c-car", 0, 0, 10, 10);

    expect(evaluateFilter(a, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(b, CLASSES, filter)).toBe(false);
  });
});

describe("evaluateFilter — AND groups", () => {
  it("'label == car AND width > 50' matches only large cars", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [
        { not: false, field: "label", op: "==", value: "car" },
        { not: false, field: "width", op: ">", value: 50 },
      ],
    };
    const smallCar = bbox("a-1", "c-car", 0, 0, 10, 10);
    const largeCar = bbox("a-2", "c-car", 0, 0, 100, 100);
    const largeDog = bbox("a-3", "c-dog", 0, 0, 100, 100);

    expect(evaluateFilter(smallCar, CLASSES, filter)).toBe(false);
    expect(evaluateFilter(largeCar, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(largeDog, CLASSES, filter)).toBe(false);
  });
});

describe("evaluateFilter — OR groups", () => {
  it("'label == car OR label == dog' matches either", () => {
    const filter: FilterGroup = {
      combinator: "OR",
      rules: [
        { not: false, field: "label", op: "==", value: "car" },
        { not: false, field: "label", op: "==", value: "dog" },
      ],
    };
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    const dog = bbox("a-2", "c-dog", 0, 0, 10, 10);
    const cat = bbox("a-3", "c-cat", 0, 0, 10, 10);

    expect(evaluateFilter(car, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(dog, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(cat, CLASSES, filter)).toBe(false);
  });
});

describe("evaluateFilter — nested groups", () => {
  it("'(label == car OR label == dog) AND width > 50' matches large cars or dogs only", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [
        {
          combinator: "OR",
          rules: [
            { not: false, field: "label", op: "==", value: "car" },
            { not: false, field: "label", op: "==", value: "dog" },
          ],
        },
        { not: false, field: "width", op: ">", value: 50 },
      ],
    };
    const smallCar = bbox("a-1", "c-car", 0, 0, 10, 10);
    const largeCar = bbox("a-2", "c-car", 0, 0, 100, 100);
    const largeDog = bbox("a-3", "c-dog", 0, 0, 100, 100);
    const largeCat = bbox("a-4", "c-cat", 0, 0, 100, 100);

    expect(evaluateFilter(smallCar, CLASSES, filter)).toBe(false);
    expect(evaluateFilter(largeCar, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(largeDog, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(largeCat, CLASSES, filter)).toBe(false);
  });
});

describe("evaluateFilter — edge cases", () => {
  it("null filter matches everything", () => {
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    expect(evaluateFilter(car, CLASSES, null)).toBe(true);
  });

  it("empty group matches everything", () => {
    const filter: FilterGroup = { combinator: "AND", rules: [] };
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    expect(evaluateFilter(car, CLASSES, filter)).toBe(true);
  });

  it("rule with empty value is skipped (matches everything)", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "" }],
    };
    const car = bbox("a-1", "c-car", 0, 0, 10, 10);
    const dog = bbox("a-2", "c-dog", 0, 0, 10, 10);
    expect(evaluateFilter(car, CLASSES, filter)).toBe(true);
    expect(evaluateFilter(dog, CLASSES, filter)).toBe(true);
  });

  it("polygon width derives from bounding rect", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "width", op: ">=", value: 100 }],
    };
    const polygon: AnnotationDraft = {
      tempId: "a-1",
      classId: "c-car",
      kind: "polygon",
      geometry: {
        kind: "polygon",
        points: [
          [0, 0],
          [100, 0],
          [100, 50],
        ],
      },
      frameId: null,
      serverId: null,
      dirty: false,
    };
    expect(evaluateFilter(polygon, CLASSES, filter)).toBe(true);
  });
});

describe("hasMeaningfulRules", () => {
  it("returns false for null filter", () => {
    expect(hasMeaningfulRules(null)).toBe(false);
  });

  it("returns false for group of empty rules", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "" }],
    };
    expect(hasMeaningfulRules(filter)).toBe(false);
  });

  it("returns true when any rule has a value", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [
        { not: false, field: "label", op: "==", value: "" },
        { not: false, field: "width", op: ">", value: 50 },
      ],
    };
    expect(hasMeaningfulRules(filter)).toBe(true);
  });

  it("descends into nested groups", () => {
    const filter: FilterGroup = {
      combinator: "AND",
      rules: [
        {
          combinator: "OR",
          rules: [{ not: false, field: "label", op: "==", value: "car" }],
        },
      ],
    };
    expect(hasMeaningfulRules(filter)).toBe(true);
  });
});

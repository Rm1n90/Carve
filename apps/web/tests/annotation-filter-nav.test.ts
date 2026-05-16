/**
 * Filter-aware asset navigation — comprehensive coverage.
 *
 * Covers ``computeMatchingAssetIds`` + ``computeFilteredNeighbours``
 * across the realistic editor scenarios:
 *
 *   • No filter → plain adjacency (existing behavior preserved)
 *   • Filter active + multiple matches across the task
 *   • Filter active + current asset itself NOT matching
 *   • Filter active + only one matching asset (prev/next null)
 *   • Filter active + zero matches (prev/next null)
 *   • Empty inputs (zero assets, zero annotations) — no crashes
 *   • Filter with non-meaningful (empty-value) rules behaves as no filter
 *   • Annotations missing asset_id are silently skipped
 */

import { describe, expect, it } from "vitest";
import {
  applyLocalAssetOverride,
  computeFilteredNeighbours,
  computeMatchingAssetIds,
} from "@/lib/annotation-filter-nav";
import type { AnnotationRaw } from "@/api/annotations";
import type { FilterGroup } from "@/lib/annotation-filter";
import type { ClassRow } from "@/api/classes";
import type { AnnotationDraft } from "@/state/annotations";

const CLASS_BUS: ClassRow = {
  id: "cls-bus",
  project_id: "p-1",
  name: "bus",
  color: "#ff0000",
  idx: 0,
  text_prompt: null,
} as ClassRow;
const CLASS_CAR: ClassRow = {
  id: "cls-car",
  project_id: "p-1",
  name: "car",
  color: "#00ff00",
  idx: 1,
  text_prompt: null,
} as ClassRow;
const CLASSES: Record<string, ClassRow> = {
  [CLASS_BUS.id]: CLASS_BUS,
  [CLASS_CAR.id]: CLASS_CAR,
};

function makeAnnotation(
  overrides: Partial<AnnotationRaw> & {
    id: string;
    asset_id: string | null;
    class_id: string;
  },
): AnnotationRaw {
  return {
    id: overrides.id,
    asset_id: overrides.asset_id,
    frame_id: overrides.frame_id ?? null,
    class_id: overrides.class_id,
    kind: overrides.kind ?? "bbox",
    geometry: overrides.geometry ?? { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
  };
}

const LABEL_EQUALS_BUS: FilterGroup = {
  combinator: "AND",
  rules: [{ not: false, field: "label", op: "==", value: "bus" }],
};

describe("computeMatchingAssetIds", () => {
  it("returns an empty set when the filter is null", () => {
    const result = computeMatchingAssetIds(
      [makeAnnotation({ id: "a", asset_id: "as-1", class_id: CLASS_BUS.id })],
      CLASSES,
      null,
    );
    expect(result.size).toBe(0);
  });

  it("returns an empty set when the filter has no meaningful rules", () => {
    const emptyFilter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "" }],
    };
    const result = computeMatchingAssetIds(
      [makeAnnotation({ id: "a", asset_id: "as-1", class_id: CLASS_BUS.id })],
      CLASSES,
      emptyFilter,
    );
    expect(result.size).toBe(0);
  });

  it("collects asset_ids of annotations matching the filter", () => {
    const annotations = [
      makeAnnotation({ id: "a1", asset_id: "as-1", class_id: CLASS_BUS.id }),
      makeAnnotation({ id: "a2", asset_id: "as-2", class_id: CLASS_CAR.id }),
      makeAnnotation({ id: "a3", asset_id: "as-3", class_id: CLASS_BUS.id }),
      // Duplicate bus on as-1 — set semantics dedupe.
      makeAnnotation({ id: "a4", asset_id: "as-1", class_id: CLASS_BUS.id }),
    ];
    const result = computeMatchingAssetIds(annotations, CLASSES, LABEL_EQUALS_BUS);
    expect([...result].sort()).toEqual(["as-1", "as-3"]);
  });

  it("skips annotations without an asset_id (legacy / orphaned rows)", () => {
    const annotations = [
      makeAnnotation({ id: "a1", asset_id: null, class_id: CLASS_BUS.id }),
      makeAnnotation({ id: "a2", asset_id: "as-2", class_id: CLASS_BUS.id }),
    ];
    const result = computeMatchingAssetIds(annotations, CLASSES, LABEL_EQUALS_BUS);
    expect([...result]).toEqual(["as-2"]);
  });

  it("returns an empty set when zero annotations match", () => {
    const annotations = [
      makeAnnotation({ id: "a1", asset_id: "as-1", class_id: CLASS_CAR.id }),
    ];
    const result = computeMatchingAssetIds(annotations, CLASSES, LABEL_EQUALS_BUS);
    expect(result.size).toBe(0);
  });
});

describe("computeFilteredNeighbours", () => {
  const ASSETS = [
    { id: "as-1" },
    { id: "as-2" },
    { id: "as-3" },
    { id: "as-4" },
    { id: "as-5" },
  ];

  describe("no filter active (empty matching set)", () => {
    it("preserves plain adjacency", () => {
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, new Set());
      expect(prev?.id).toBe("as-2");
      expect(next?.id).toBe("as-4");
    });

    it("returns null prev at index 0 + null next at the end", () => {
      expect(computeFilteredNeighbours(ASSETS, 0, new Set()).prev).toBeNull();
      expect(computeFilteredNeighbours(ASSETS, 4, new Set()).next).toBeNull();
    });
  });

  describe("filter active", () => {
    it("walks through matching assets, skipping non-matchers", () => {
      // Matching: as-2, as-4. Current = as-3 (idx 2).
      const matching = new Set(["as-2", "as-4"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, matching);
      expect(prev?.id).toBe("as-2");
      expect(next?.id).toBe("as-4");
    });

    it("from a non-matching current asset, prev/next point at surrounding matches", () => {
      // Matching: as-1, as-4. Current = as-3 (idx 2, NOT matching).
      const matching = new Set(["as-1", "as-4"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, matching);
      expect(prev?.id).toBe("as-1");
      expect(next?.id).toBe("as-4");
    });

    it("from a matching current asset, neighbours are the OTHER matches (current excluded)", () => {
      // Matching: as-1, as-3, as-5. Current = as-3.
      const matching = new Set(["as-1", "as-3", "as-5"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, matching);
      expect(prev?.id).toBe("as-1");
      expect(next?.id).toBe("as-5");
    });

    it("single match: prev and next both null when only the current matches", () => {
      const matching = new Set(["as-3"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, matching);
      expect(prev).toBeNull();
      expect(next).toBeNull();
    });

    it("first matching asset: prev null, next is the next match", () => {
      // Matching: as-2, as-5. Current = as-2 (idx 1, first match).
      const matching = new Set(["as-2", "as-5"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 1, matching);
      expect(prev).toBeNull();
      expect(next?.id).toBe("as-5");
    });

    it("last matching asset: next null, prev is the previous match", () => {
      // Matching: as-1, as-4. Current = as-4 (idx 3, last match).
      const matching = new Set(["as-1", "as-4"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 3, matching);
      expect(prev?.id).toBe("as-1");
      expect(next).toBeNull();
    });

    it("empty matching set is treated as no-filter (plain adjacency fallback)", () => {
      // ``matching.size > 0`` triggers the filtered branch. An empty
      // set falls through to plain adjacency by design so arrow nav
      // never gets stuck when the page's empty-state UI handles the
      // "no matches" message separately.
      const matching = new Set<string>();
      const { prev, next } = computeFilteredNeighbours(ASSETS, 2, matching);
      expect(prev?.id).toBe("as-2");
      expect(next?.id).toBe("as-4");
    });

    it("current asset not in list (idx -1) walks matches from the end", () => {
      // Matching: as-1, as-3. Current asset not in task list.
      const matching = new Set(["as-1", "as-3"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, -1, matching);
      // Walking back from past-the-end → prev is the LAST match.
      expect(prev?.id).toBe("as-3");
      expect(next).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("empty task asset list returns nulls", () => {
      const { prev, next } = computeFilteredNeighbours([], 0, new Set(["x"]));
      expect(prev).toBeNull();
      expect(next).toBeNull();
    });

    it("matching set referencing assets not in the list is harmless", () => {
      // Stale Set after a delete — the helper just ignores ghost IDs
      // and walks the remaining matchers.
      const matching = new Set(["ghost-1", "as-4", "ghost-2"]);
      const { prev, next } = computeFilteredNeighbours(ASSETS, 1, matching);
      expect(prev).toBeNull();
      expect(next?.id).toBe("as-4");
    });
  });

  describe("end-to-end: simulating the user's reported scenario", () => {
    it("filter 'label == bus' steps the user through bus-containing images only", () => {
      // 5 task assets; bus annotations only on as-2 and as-5.
      const taskAssets = [
        { id: "as-1" },
        { id: "as-2" },
        { id: "as-3" },
        { id: "as-4" },
        { id: "as-5" },
      ];
      const annotations: AnnotationRaw[] = [
        makeAnnotation({ id: "a1", asset_id: "as-1", class_id: CLASS_CAR.id }),
        makeAnnotation({ id: "a2", asset_id: "as-2", class_id: CLASS_BUS.id }),
        makeAnnotation({ id: "a3", asset_id: "as-3", class_id: CLASS_CAR.id }),
        makeAnnotation({ id: "a4", asset_id: "as-4", class_id: CLASS_CAR.id }),
        makeAnnotation({ id: "a5", asset_id: "as-5", class_id: CLASS_BUS.id }),
      ];

      const matching = computeMatchingAssetIds(
        annotations,
        CLASSES,
        LABEL_EQUALS_BUS,
      );
      expect([...matching].sort()).toEqual(["as-2", "as-5"]);

      // User starts at as-1 — pressing Right should jump to as-2.
      let nav = computeFilteredNeighbours(taskAssets, 0, matching);
      expect(nav.next?.id).toBe("as-2");

      // Now on as-2 — pressing Right should jump to as-5, skipping
      // as-3 and as-4 (neither contains a bus).
      nav = computeFilteredNeighbours(taskAssets, 1, matching);
      expect(nav.next?.id).toBe("as-5");
      expect(nav.prev).toBeNull();

      // On as-5 — pressing Left should jump back to as-2.
      nav = computeFilteredNeighbours(taskAssets, 4, matching);
      expect(nav.prev?.id).toBe("as-2");
      expect(nav.next).toBeNull();
    });

    it("when the user clears the filter, navigation falls back to plain adjacency", () => {
      const taskAssets = [
        { id: "as-1" },
        { id: "as-2" },
        { id: "as-3" },
      ];
      const nav = computeFilteredNeighbours(taskAssets, 1, new Set());
      expect(nav.prev?.id).toBe("as-1");
      expect(nav.next?.id).toBe("as-3");
    });
  });
});

function makeDraft(
  overrides: Partial<AnnotationDraft> & { classId: string },
): AnnotationDraft {
  return {
    tempId: overrides.tempId ?? "t-1",
    classId: overrides.classId,
    kind: overrides.kind ?? "bbox",
    geometry:
      overrides.geometry
      ?? ({ kind: "bbox", x: 0, y: 0, w: 10, h: 10 } as never),
    frameId: overrides.frameId ?? null,
    serverId: overrides.serverId ?? null,
    dirty: overrides.dirty ?? false,
    zOrder: overrides.zOrder ?? 0,
    status: overrides.status ?? "proposed",
    reviewedById: overrides.reviewedById ?? null,
    reviewedAt: overrides.reviewedAt ?? null,
    prevGeometry: overrides.prevGeometry ?? null,
  };
}

describe("applyLocalAssetOverride (live-store override for current asset)", () => {
  it("removes the current asset from matching when the user deleted the last match locally", () => {
    // Cache still says as-2 has a Bus (the server hasn't been told
    // about the delete yet). User has deleted it locally → the live
    // annotations store has no Bus on as-2 anymore.
    const cached = new Set(["as-1", "as-2", "as-3"]);
    const liveOnCurrent: AnnotationDraft[] = [
      // Only a Car remains on the current asset.
      makeDraft({ classId: CLASS_CAR.id }),
    ];
    const next = applyLocalAssetOverride(
      cached,
      "as-2",
      liveOnCurrent,
      CLASSES,
      LABEL_EQUALS_BUS,
    );
    expect(next.has("as-2")).toBe(false);
    // Other assets in the matching set are untouched.
    expect(next.has("as-1")).toBe(true);
    expect(next.has("as-3")).toBe(true);
  });

  it("adds the current asset to matching when the user just drew the first matching annotation locally", () => {
    // Cache doesn't list as-2 — the autosave hasn't fired yet — but
    // locally the user has drawn a Bus.
    const cached = new Set(["as-5"]);
    const liveOnCurrent: AnnotationDraft[] = [
      makeDraft({ classId: CLASS_BUS.id }),
    ];
    const next = applyLocalAssetOverride(
      cached,
      "as-2",
      liveOnCurrent,
      CLASSES,
      LABEL_EQUALS_BUS,
    );
    expect(next.has("as-2")).toBe(true);
    expect(next.has("as-5")).toBe(true);
  });

  it("leaves the current asset in matching when other locally-drawn annotations still match", () => {
    const cached = new Set(["as-2"]);
    const liveOnCurrent: AnnotationDraft[] = [
      // Two Bus annotations; the user deletes one — one remains.
      makeDraft({ tempId: "t-1", classId: CLASS_BUS.id }),
      makeDraft({ tempId: "t-2", classId: CLASS_CAR.id }),
    ];
    const next = applyLocalAssetOverride(
      cached,
      "as-2",
      liveOnCurrent,
      CLASSES,
      LABEL_EQUALS_BUS,
    );
    expect(next.has("as-2")).toBe(true);
  });

  it("currentAssetId=null disables the override (returns matching unchanged)", () => {
    const cached = new Set(["as-1", "as-2"]);
    const next = applyLocalAssetOverride(
      cached,
      null,
      [],
      CLASSES,
      LABEL_EQUALS_BUS,
    );
    expect([...next].sort()).toEqual(["as-1", "as-2"]);
  });

  it("no-op when the filter has no meaningful rules", () => {
    const emptyFilter: FilterGroup = {
      combinator: "AND",
      rules: [{ not: false, field: "label", op: "==", value: "" }],
    };
    const cached = new Set(["as-1"]);
    const next = applyLocalAssetOverride(
      cached,
      "as-1",
      [],
      CLASSES,
      emptyFilter,
    );
    expect([...next]).toEqual(["as-1"]);
  });

  it("end-to-end bug scenario: delete last Bus on current asset → arrow nav skips it", () => {
    // 5 assets; as-2 and as-5 originally have Bus. User is on as-2,
    // deletes the only Bus there.
    const taskAssets = [
      { id: "as-1" },
      { id: "as-2" },
      { id: "as-3" },
      { id: "as-4" },
      { id: "as-5" },
    ];
    const cachedAnnotations: AnnotationRaw[] = [
      makeAnnotation({ id: "a1", asset_id: "as-1", class_id: CLASS_CAR.id }),
      makeAnnotation({ id: "a2", asset_id: "as-2", class_id: CLASS_BUS.id }),
      makeAnnotation({ id: "a3", asset_id: "as-3", class_id: CLASS_CAR.id }),
      makeAnnotation({ id: "a4", asset_id: "as-4", class_id: CLASS_CAR.id }),
      makeAnnotation({ id: "a5", asset_id: "as-5", class_id: CLASS_BUS.id }),
    ];
    const cachedMatching = computeMatchingAssetIds(
      cachedAnnotations,
      CLASSES,
      LABEL_EQUALS_BUS,
    );
    expect([...cachedMatching].sort()).toEqual(["as-2", "as-5"]);

    // User is on as-2 with the Bus deleted from the local store.
    const liveOnCurrent: AnnotationDraft[] = [];
    const effective = applyLocalAssetOverride(
      cachedMatching,
      "as-2",
      liveOnCurrent,
      CLASSES,
      LABEL_EQUALS_BUS,
    );

    // The matching set now correctly excludes as-2.
    expect([...effective].sort()).toEqual(["as-5"]);

    // Pressing Left from as-5 must NOT land back on as-2 — it should
    // exit the matching set entirely (prev=null, next=null).
    const nav = computeFilteredNeighbours(taskAssets, 4, effective);
    expect(nav.prev).toBeNull();
    expect(nav.next).toBeNull();
  });
});

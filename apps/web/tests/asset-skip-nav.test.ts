/**
 * Tests for the next-empty / next-unreviewed asset skip helpers.
 *
 * Pins:
 *   * forward / backward walk
 *   * current asset itself is never returned
 *   * no candidate → null
 *   * "empty" vs "unreviewed" don't overlap (an empty asset must not
 *     match the unreviewed predicate; the user has a dedicated skip)
 *   * annotations whose status is undefined are treated as
 *     "needs work"
 *   * annotations with asset_id=null are ignored
 */
import { describe, expect, it } from "vitest";
import {
  findNextEmptyAsset,
  findNextUnreviewedAsset,
  type SkipDirection,
} from "@/lib/asset-skip-nav";
import type { AnnotationRaw } from "@/api/annotations";

interface MiniAsset { id: string }

function ann(
  asset_id: string | null,
  status: "proposed" | "accepted" | "rejected" | undefined,
): AnnotationRaw {
  return {
    id: `${asset_id ?? "free"}-${Math.random().toString(36).slice(2, 6)}`,
    asset_id,
    frame_id: null,
    class_id: "c1",
    kind: "bbox",
    geometry: {},
    created_at: "2026-05-16T00:00:00Z",
    status,
  };
}

const ASSETS: MiniAsset[] = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "d" },
  { id: "e" },
];

describe("findNextEmptyAsset", () => {
  it("walks forward to the next asset with zero annotations", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("b", "accepted"),
      ann("d", "accepted"),
      ann("e", "accepted"),
    ];
    const r = findNextEmptyAsset(ASSETS, raw, 0, "forward");
    expect(r?.id).toBe("c");
  });

  it("walks backward", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("c", "accepted"),
      ann("d", "accepted"),
      ann("e", "accepted"),
    ];
    const r = findNextEmptyAsset(ASSETS, raw, 3, "backward");
    expect(r?.id).toBe("b");
  });

  it("never returns the current asset (advance from empty to next empty)", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("d", "accepted"),
    ];
    const r = findNextEmptyAsset(ASSETS, raw, 1, "forward");
    expect(r?.id).toBe("c");
  });

  it("returns null when no empty asset exists ahead", () => {
    const raw: AnnotationRaw[] = ASSETS.map((a) => ann(a.id, "accepted"));
    const r = findNextEmptyAsset(ASSETS, raw, 0, "forward");
    expect(r).toBeNull();
  });

  it("treats asset_id=null annotations as not assigning a count", () => {
    const raw: AnnotationRaw[] = [ann(null, "accepted")];
    const r = findNextEmptyAsset(ASSETS, raw, -1, "forward");
    expect(r?.id).toBe("a");
  });

  it("returns null on an empty asset list", () => {
    expect(findNextEmptyAsset([], [], 0, "forward")).toBeNull();
  });
});

describe("findNextUnreviewedAsset", () => {
  it("skips empty assets and finds the first one with a non-accepted annotation", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("c", "proposed"),
      ann("e", "accepted"),
    ];
    const r = findNextUnreviewedAsset(ASSETS, raw, 0, "forward");
    expect(r?.id).toBe("c");
  });

  it("treats missing-status as needs-work", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("b", undefined),
    ];
    const r = findNextUnreviewedAsset(ASSETS, raw, 0, "forward");
    expect(r?.id).toBe("b");
  });

  it("treats rejected as needs-work (user still needs to act on it)", () => {
    const raw: AnnotationRaw[] = [ann("a", "rejected")];
    const r = findNextUnreviewedAsset(ASSETS, raw, -1, "forward");
    expect(r?.id).toBe("a");
  });

  it("walks backward", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "proposed"),
      ann("b", "accepted"),
      ann("e", "accepted"),
    ];
    const r = findNextUnreviewedAsset(ASSETS, raw, 4, "backward");
    expect(r?.id).toBe("a");
  });

  it("returns null when every asset is fully accepted", () => {
    const raw: AnnotationRaw[] = ASSETS.map((a) => ann(a.id, "accepted"));
    expect(findNextUnreviewedAsset(ASSETS, raw, 0, "forward")).toBeNull();
  });

  it("treats accepted+proposed-on-same-asset as needs-work", () => {
    const raw: AnnotationRaw[] = [
      ann("a", "accepted"),
      ann("a", "accepted"),
      ann("a", "proposed"),
    ];
    expect(findNextUnreviewedAsset(ASSETS, raw, -1, "forward")?.id).toBe("a");
  });
});

describe("direction parameter typing", () => {
  it("accepts forward and backward as the only valid directions", () => {
    const fwd: SkipDirection = "forward";
    const back: SkipDirection = "backward";
    expect(findNextEmptyAsset(ASSETS, [], 0, fwd)?.id).toBe("b");
    expect(findNextEmptyAsset(ASSETS, [], 4, back)?.id).toBe("d");
  });
});

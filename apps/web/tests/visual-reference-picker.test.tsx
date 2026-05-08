// Armin Mehri — mehri.armin@gmail.com
/**
 * VisualReferencePicker — shared component extracted from YoloeDialog.
 *
 * Asserts:
 *   - refKindFilter="bbox" hides polygon refs
 *   - First-pick toggle auto-fills source class id
 *   - Polygon refs round-trip their points through the pick payload
 *     (so SAM consumers can use polygon geometry directly)
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { VisualReferencePicker } from "@/components/annotation/VisualReferencePicker";

describe("VisualReferencePicker", () => {
  const baseClasses = [
    {
      id: "c1",
      project_id: "p1",
      name: "Cat",
      color: "#f00",
      idx: 0,
      text_prompt: null,
      is_active: true,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;
  const baseAssets = [
    {
      id: "a1",
      original_name: "img1.jpg",
      thumbnail_url: "http://x/t.jpg",
      kind: "image" as const,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;

  it("filters refs by refKindFilter='bbox' (polygon refs hidden)", () => {
    const annotationsByAssetId = new Map([
      [
        "a1",
        [
          {
            id: "r1",
            classId: "c1",
            kind: "bbox" as const,
            geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
          },
          {
            id: "r2",
            classId: "c1",
            kind: "polygon" as const,
            geometry: {
              kind: "polygon",
              points: [
                [0, 0],
                [5, 0],
                [5, 5],
              ],
            },
          },
        ],
      ],
    ]);
    render(
      <VisualReferencePicker
        assetId="other"
        taskId="t1"
        classes={baseClasses}
        pickableAssets={baseAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={{}}
        picks={{}}
        onPicksChange={() => {}}
        refKindFilter="bbox"
      />,
    );
    expect(screen.queryByTestId("yoloe-visual-ref-r1")).toBeTruthy();
    expect(screen.queryByTestId("yoloe-visual-ref-r2")).toBeNull();
  });

  it("auto-fills source class on first pick toggle", () => {
    const onPicksChange = vi.fn();
    const annotationsByAssetId = new Map([
      [
        "a1",
        [
          {
            id: "r1",
            classId: "c1",
            kind: "bbox" as const,
            geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
          },
        ],
      ],
    ]);
    render(
      <VisualReferencePicker
        assetId="other"
        taskId="t1"
        classes={baseClasses}
        pickableAssets={baseAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={{}}
        picks={{}}
        onPicksChange={onPicksChange}
      />,
    );
    fireEvent.click(
      screen.getByTestId("yoloe-visual-ref-r1").querySelector("button")!,
    );
    const updated = onPicksChange.mock.calls[0][0];
    expect(updated["a1:r1"].classId).toBe("c1");
    // Geometry round-trip through pick:
    expect(updated["a1:r1"].geometry).toEqual({
      kind: "bbox",
      xyxy: [0, 0, 10, 10],
    });
  });

  it("auto-fills polygon geometry on a polygon ref pick", () => {
    const onPicksChange = vi.fn();
    const annotationsByAssetId = new Map([
      [
        "a1",
        [
          {
            id: "r2",
            classId: "c1",
            kind: "polygon" as const,
            geometry: {
              kind: "polygon",
              points: [
                [1, 1],
                [10, 1],
                [10, 10],
              ],
            },
          },
        ],
      ],
    ]);
    render(
      <VisualReferencePicker
        assetId="other"
        taskId="t1"
        classes={baseClasses}
        pickableAssets={baseAssets}
        annotationsByAssetId={annotationsByAssetId}
        annotationsById={{}}
        picks={{}}
        onPicksChange={onPicksChange}
        refKindFilter="polygon"
      />,
    );
    fireEvent.click(
      screen.getByTestId("yoloe-visual-ref-r2").querySelector("button")!,
    );
    const updated = onPicksChange.mock.calls[0][0];
    expect(updated["a1:r2"].geometry).toEqual({
      kind: "polygon",
      points: [
        [1, 1],
        [10, 1],
        [10, 10],
      ],
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { InfoDialog } from "@/components/annotation/InfoDialog";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import type { Task } from "@/api/tasks";
import type { AssetWithUrl } from "@/api/assets";
import type { ClassRow } from "@/api/classes";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  // Reset annotations store between tests so leakage from one fixture
  // doesn't contaminate the next render.
  useAnnotations.getState().reset([]);
});

const TASK: Task = {
  id: "task-1",
  project_id: "proj-1",
  name: "Demo task",
  kind: "image",
  created_at: "2026-04-12T10:00:00Z",
};

const ASSET: AssetWithUrl = {
  asset: {
    id: "asset-1",
    task_id: "task-1",
    kind: "image",
    xxh3_128: "abc",
    mime: "image/png",
    size_bytes: 12345,
    width: 640,
    height: 480,
    frames: 1,
    original_name: "frame_001.png",
    created_at: "2026-04-12T10:01:00Z",
    thumbnail_url: null,
  },
  url: "https://example.test/asset-1.png",
  frame_id: "frame-1",
};

const CLASS_CAR: ClassRow = {
  id: "class-car",
  project_id: "proj-1",
  idx: 0,
  name: "car",
  color: "#ff0000",
  attributes: {},
  created_at: "2026-04-01T00:00:00Z",
};

const CLASS_PERSON: ClassRow = {
  id: "class-person",
  project_id: "proj-1",
  idx: 1,
  name: "person",
  color: "#00ff00",
  attributes: {},
  created_at: "2026-04-01T00:00:00Z",
};

function makeDraft(
  partial: Partial<AnnotationDraft> & Pick<AnnotationDraft, "tempId" | "classId" | "kind" | "geometry">,
): AnnotationDraft {
  return {
    frameId: null,
    serverId: null,
    dirty: false,
    trackId: null,
    zOrder: 0,
    ...partial,
  };
}

const FIXTURE_DRAFTS: AnnotationDraft[] = [
  // 3 bboxes of class "car"
  makeDraft({
    tempId: "t-car-bbox-1",
    classId: CLASS_CAR.id,
    kind: "bbox",
    geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
  }),
  makeDraft({
    tempId: "t-car-bbox-2",
    classId: CLASS_CAR.id,
    kind: "bbox",
    geometry: { kind: "bbox", x: 12, y: 0, w: 10, h: 10 },
  }),
  makeDraft({
    tempId: "t-car-bbox-3",
    classId: CLASS_CAR.id,
    kind: "bbox",
    geometry: { kind: "bbox", x: 24, y: 0, w: 10, h: 10 },
  }),
  // 2 polygons of class "car"
  makeDraft({
    tempId: "t-car-poly-1",
    classId: CLASS_CAR.id,
    kind: "polygon",
    geometry: {
      kind: "polygon",
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    },
  }),
  makeDraft({
    tempId: "t-car-poly-2",
    classId: CLASS_CAR.id,
    kind: "polygon",
    geometry: {
      kind: "polygon",
      points: [
        [20, 20],
        [30, 20],
        [30, 30],
      ],
    },
  }),
  // 1 tag of class "person"
  makeDraft({
    tempId: "t-person-tag-1",
    classId: CLASS_PERSON.id,
    kind: "tag",
    geometry: { kind: "tag" },
  }),
];

beforeEach(() => {
  useAnnotations.getState().reset(FIXTURE_DRAFTS);
});

describe("InfoDialog", () => {
  it("does not render content when open=false", () => {
    render(
      <InfoDialog
        open={false}
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={42}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail="armin@example.test"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders Overview with Total assets matching the prop", () => {
    render(
      <InfoDialog
        open
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={42}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail="armin@example.test"
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("info-total-assets").textContent).toBe("42");
    // Annotations count = 3 bbox + 2 poly + 1 tag = 6
    expect(screen.getByTestId("info-total-annotations").textContent).toBe("6");
    expect(screen.getByTestId("info-assignee").textContent).toBe(
      "armin@example.test",
    );
  });

  it("falls back to 'Nobody' when assignee is missing", () => {
    render(
      <InfoDialog
        open
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={1}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail={null}
      />,
    );
    expect(screen.getByTestId("info-assignee").textContent).toBe("Nobody");
  });

  it("aggregates annotations by class+kind into the stats table", () => {
    render(
      <InfoDialog
        open
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={1}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail={null}
      />,
    );
    // car row: Bbox=3, Polygon=2, Mask=0, Tag=0, Manually=5, Total=5
    const carRow = screen.getByTestId("info-stats-row-car");
    const carCells = carRow.querySelectorAll("td");
    expect(carCells[0].textContent).toBe("car");
    expect(carCells[1].textContent).toBe("3"); // Bbox
    expect(carCells[2].textContent).toBe("2"); // Polygon
    expect(carCells[3].textContent).toBe("0"); // Mask
    expect(carCells[4].textContent).toBe("0"); // Tag
    expect(carCells[5].textContent).toBe("5"); // Manually
    expect(carCells[6].textContent).toBe("5"); // Total

    // person row: Bbox=0, Polygon=0, Mask=0, Tag=1, Manually=1, Total=1
    const personRow = screen.getByTestId("info-stats-row-person");
    const personCells = personRow.querySelectorAll("td");
    expect(personCells[0].textContent).toBe("person");
    expect(personCells[1].textContent).toBe("0");
    expect(personCells[2].textContent).toBe("0");
    expect(personCells[3].textContent).toBe("0");
    expect(personCells[4].textContent).toBe("1");
    expect(personCells[5].textContent).toBe("1");
    expect(personCells[6].textContent).toBe("1");
  });

  it("renders a TOTAL footer summing across classes", () => {
    render(
      <InfoDialog
        open
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={1}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail={null}
      />,
    );
    const tfoot = screen.getByTestId("info-stats-totals");
    const cells = tfoot.querySelectorAll("td");
    // Order: label, Bbox, Polygon, Mask, Tag, Manually, Total
    expect(cells[0].textContent?.toLowerCase()).toContain("total");
    expect(cells[1].textContent).toBe("3"); // Bbox total
    expect(cells[2].textContent).toBe("2"); // Polygon total
    expect(cells[3].textContent).toBe("0"); // Mask total
    expect(cells[4].textContent).toBe("1"); // Tag total
    expect(cells[5].textContent).toBe("6"); // Manually total
    expect(cells[6].textContent).toBe("6"); // Total total
  });

  it("OK button invokes onOpenChange(false) to close the dialog", () => {
    const calls: boolean[] = [];
    render(
      <InfoDialog
        open
        onOpenChange={(v) => calls.push(v)}
        task={TASK}
        asset={ASSET}
        totalAssets={1}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail={null}
      />,
    );
    fireEvent.click(screen.getByTestId("info-dialog-ok"));
    expect(calls).toContain(false);
  });

  it("shows an empty-state row when there are no annotations", () => {
    useAnnotations.getState().reset([]);
    render(
      <InfoDialog
        open
        onOpenChange={() => undefined}
        task={TASK}
        asset={ASSET}
        totalAssets={1}
        classes={[CLASS_CAR, CLASS_PERSON]}
        assigneeEmail={null}
      />,
    );
    expect(screen.getByTestId("info-stats-empty")).toBeInTheDocument();
    expect(screen.getByTestId("info-total-annotations").textContent).toBe("0");
  });
});

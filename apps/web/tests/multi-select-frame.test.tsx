import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * Item 4 (v2.7 wave 2) - "I should be able to select multi bbox to
 * remove the bboxes at batch". Audit at /tmp/v27-wave2-item4-audit.md.
 *
 * Bug 1: AnnotateAssetPage Cmd+A handler hardcoded selectAll(null).
 *        Video frames where frame_id is non-null returned 0 ids.
 * Bug 2: No visual feedback for batch selection.
 *
 * Tests cover:
 *   (a) Store-level selectAll respects frameId filter for both null and
 *       non-null values.
 *   (b) The new SelectionCountBadge renders only when selectedIds.length > 1.
 */

import { useAnnotations } from "@/state/annotations";
import { SelectionCountBadge } from "@/components/annotation/SelectionCountBadge";

afterEach(() => {
  cleanup();
});

describe("Item 4 - selectAll respects frame", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    // Two annotations on frame-A, one on frame-B, one with null frame.
    useAnnotations.getState().add({
      tempId: "t-A1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: "f-A",
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-A2",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 10, y: 10, w: 5, h: 5 },
      frameId: "f-A",
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-B1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 20, y: 20, w: 5, h: 5 },
      frameId: "f-B",
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-N1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 30, y: 30, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
  });

  it("selectAll(null) selects only annotations with frameId === null", () => {
    useAnnotations.getState().selectAll(null);
    const ids = [...useAnnotations.getState().selectedIds].sort();
    expect(ids).toEqual(["t-N1"]);
  });

  it("selectAll('f-A') selects only annotations with frameId === 'f-A'", () => {
    useAnnotations.getState().selectAll("f-A");
    const ids = [...useAnnotations.getState().selectedIds].sort();
    expect(ids).toEqual(["t-A1", "t-A2"]);
  });

  it("selectAll('f-B') selects only annotations with frameId === 'f-B'", () => {
    useAnnotations.getState().selectAll("f-B");
    const ids = [...useAnnotations.getState().selectedIds].sort();
    expect(ids).toEqual(["t-B1"]);
  });

  it("Delete loop after multi-select removes all selected drafts", () => {
    useAnnotations.getState().selectAll("f-A");
    const ids = useAnnotations.getState().selectedIds;
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      useAnnotations.getState().remove(id);
    }
    expect(useAnnotations.getState().byId["t-A1"]).toBeUndefined();
    expect(useAnnotations.getState().byId["t-A2"]).toBeUndefined();
    expect(useAnnotations.getState().byId["t-B1"]).toBeDefined();
    expect(useAnnotations.getState().byId["t-N1"]).toBeDefined();
  });

  it("shift+click toggle (toggleSelect) works through 3+ items", () => {
    useAnnotations.getState().clearSelection();
    useAnnotations.getState().toggleSelect("t-A1");
    useAnnotations.getState().toggleSelect("t-A2");
    useAnnotations.getState().toggleSelect("t-B1");
    expect([...useAnnotations.getState().selectedIds].sort()).toEqual([
      "t-A1",
      "t-A2",
      "t-B1",
    ]);
    // De-select t-A1 by shift-clicking again.
    useAnnotations.getState().toggleSelect("t-A1");
    expect([...useAnnotations.getState().selectedIds].sort()).toEqual([
      "t-A2",
      "t-B1",
    ]);
  });
});

describe("Item 4 - SelectionCountBadge", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
  });

  it("renders nothing when 0 ids are selected", () => {
    render(<SelectionCountBadge />);
    expect(screen.queryByTestId("selection-count-badge")).toBeNull();
  });

  it("renders nothing when only 1 id is selected", () => {
    useAnnotations.getState().add({
      tempId: "t-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().select("t-1");
    render(<SelectionCountBadge />);
    expect(screen.queryByTestId("selection-count-badge")).toBeNull();
  });

  it("renders count + Delete hint when 2 or more ids are selected", () => {
    useAnnotations.getState().add({
      tempId: "t-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-2",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 10, y: 10, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "t-3",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 20, y: 20, w: 5, h: 5 },
      frameId: null,
      serverId: null,
      dirty: true,
    });
    act(() => {
      useAnnotations.getState().selectMany(["t-1", "t-2", "t-3"]);
    });
    render(<SelectionCountBadge />);
    const badge = screen.getByTestId("selection-count-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("3");
    expect(badge.textContent?.toLowerCase()).toContain("delete");
  });
});

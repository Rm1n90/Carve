import { describe, expect, it, beforeEach } from "vitest";

import { useClassRecents } from "@/state/classRecents";

function reset(): void {
  useClassRecents.setState({ pinnedByProject: {}, recentByProject: {} });
}

describe("classRecents store — pin / unpin", () => {
  beforeEach(reset);

  it("pin adds classId to the project's pinned list", () => {
    useClassRecents.getState().pin("p-1", "c-a");
    expect(useClassRecents.getState().getPinned("p-1")).toEqual(["c-a"]);
    expect(useClassRecents.getState().isPinned("p-1", "c-a")).toBe(true);
  });

  it("pin is idempotent — same classId twice does not duplicate", () => {
    useClassRecents.getState().pin("p-1", "c-a");
    useClassRecents.getState().pin("p-1", "c-a");
    expect(useClassRecents.getState().getPinned("p-1")).toEqual(["c-a"]);
  });

  it("unpin removes classId; unpinning twice is a no-op", () => {
    useClassRecents.getState().pin("p-1", "c-a");
    useClassRecents.getState().unpin("p-1", "c-a");
    useClassRecents.getState().unpin("p-1", "c-a");
    expect(useClassRecents.getState().getPinned("p-1")).toEqual([]);
    expect(useClassRecents.getState().isPinned("p-1", "c-a")).toBe(false);
  });

  it("togglePin flips state", () => {
    const { togglePin, isPinned } = useClassRecents.getState();
    togglePin("p-1", "c-a");
    expect(isPinned("p-1", "c-a")).toBe(true);
    togglePin("p-1", "c-a");
    expect(isPinned("p-1", "c-a")).toBe(false);
  });

  it("pins are scoped per project", () => {
    useClassRecents.getState().pin("p-1", "c-a");
    expect(useClassRecents.getState().getPinned("p-2")).toEqual([]);
    expect(useClassRecents.getState().isPinned("p-2", "c-a")).toBe(false);
  });
});

describe("classRecents store — recordUse", () => {
  beforeEach(reset);

  it("records use at the front of the list", () => {
    useClassRecents.getState().recordUse("p-1", "c-a");
    useClassRecents.getState().recordUse("p-1", "c-b");
    expect(useClassRecents.getState().getRecent("p-1")).toEqual(["c-b", "c-a"]);
  });

  it("dedupes — re-using a class moves it to the front instead of duplicating", () => {
    useClassRecents.getState().recordUse("p-1", "c-a");
    useClassRecents.getState().recordUse("p-1", "c-b");
    useClassRecents.getState().recordUse("p-1", "c-a");
    expect(useClassRecents.getState().getRecent("p-1")).toEqual(["c-a", "c-b"]);
  });

  it("caps at 8 entries (oldest evicted)", () => {
    const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6", "c-7", "c-8", "c-9"];
    for (const id of ids) useClassRecents.getState().recordUse("p-1", id);
    const recent = useClassRecents.getState().getRecent("p-1");
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe("c-9");
    expect(recent).not.toContain("c-1");
  });

  it("recent is scoped per project", () => {
    useClassRecents.getState().recordUse("p-1", "c-a");
    expect(useClassRecents.getState().getRecent("p-2")).toEqual([]);
  });
});

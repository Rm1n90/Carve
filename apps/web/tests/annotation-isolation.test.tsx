import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * v2.5.1 — annotations must stay isolated per asset.
 *
 * Pre-fix, AnnotateAssetPage hardcoded frameId=null for image tasks and
 * the per-task annotations query fetched ALL annotations across the
 * task. Drawing a bbox on asset A made it visible on every other image
 * because every annotation saved with frame_id=null and the query was
 * unscoped.
 *
 * Post-fix the page reads ``assetQ.data.frame_id`` and the query keys
 * include the frame_id, giving each asset its own React Query cache
 * entry and its own seeded store contents.
 */

vi.mock("@/api/assets", () => ({
  assetsApi: {
    get: vi.fn().mockImplementation((id: string) => {
      const map: Record<string, string> = { "a-A": "frame-A", "a-B": "frame-B" };
      return Promise.resolve({
        asset: {
          id,
          task_id: "t-1",
          kind: "image",
          xxh3_128: id,
          mime: "image/png",
          size_bytes: 1,
          width: 200,
          height: 150,
          frames: 1,
          original_name: `${id}.png`,
          created_at: "2026-04-25",
        },
        url: `https://fake/${id}.png`,
        frame_id: map[id] ?? null,
      });
    }),
    listForTask: vi.fn().mockResolvedValue([
      {
        id: "a-A",
        task_id: "t-1",
        kind: "image",
        xxh3_128: "a-A",
        mime: "image/png",
        size_bytes: 1,
        width: 200,
        height: 150,
        frames: 1,
        original_name: "a-A.png",
        created_at: "2026-04-25",
      },
      {
        id: "a-B",
        task_id: "t-1",
        kind: "image",
        xxh3_128: "a-B",
        mime: "image/png",
        size_bytes: 1,
        width: 200,
        height: 150,
        frames: 1,
        original_name: "a-B.png",
        created_at: "2026-04-26",
      },
    ]),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/projects/p-1/tasks/t-1/assets/a-A" } }),
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn().mockResolvedValue([
      { id: "c-1", project_id: "p-1", idx: 0, name: "car", color: "#ff0000",
        attributes: {}, created_at: "" },
    ]),
  },
}));

// Per-frame annotation lists keyed on the frame_id arg.
const annotationsByFrame: Record<string, unknown[]> = {
  "frame-A": [
    {
      tempId: "ann-A",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: "frame-A",
      serverId: "ann-A",
      dirty: false,
      zOrder: 0,
    },
  ],
  "frame-B": [
    {
      tempId: "ann-B",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 50, y: 50, w: 8, h: 8 },
      frameId: "frame-B",
      serverId: "ann-B",
      dirty: false,
      zOrder: 0,
    },
  ],
};

vi.mock("@/api/annotations", () => ({
  annotationsApi: {
    listForTask: vi.fn().mockImplementation((_taskId: string, frameId?: string) => {
      if (!frameId) return Promise.resolve([]);
      return Promise.resolve(annotationsByFrame[frameId] ?? []);
    }),
    batch: vi.fn().mockResolvedValue({ created: [], updated: [], deleted: [] }),
  },
}));

vi.mock("@/components/annotation/AnnotationCanvas", () => ({
  AnnotationCanvas: () => <div data-testid="annotation-canvas" />,
}));

vi.mock("@/components/nav/TopBar", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));
vi.mock("@/components/nav/LeftNav", () => ({
  LeftNav: () => <div data-testid="left-nav" />,
}));
vi.mock("@/components/nav/BottomBar", () => ({
  BottomBar: ({ filename }: { filename: string }) => (
    <div data-testid="bottom-bar">{filename}</div>
  ),
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: "p-1", name: "P1", description: null }),
  },
}));

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi.fn().mockResolvedValue({ active: "sam2.1-base+", available: ["sam2.1-base+"] }),
  },
  weightsApi: {
    listForProject: vi.fn().mockResolvedValue([]),
    listWorkspace: vi.fn().mockResolvedValue([]),
  },
  inferenceApi: {
    predictYolo: vi.fn().mockResolvedValue({ count: 0 }),
  },
  trashApi: { list: vi.fn(), restore: vi.fn(), hardDelete: vi.fn() },
}));

vi.mock("@/components/annotation/AssetThumbnailStrip", () => ({
  AssetThumbnailStrip: () => <div data-testid="asset-thumbnail-strip" />,
}));

vi.mock("@/components/annotation/KeyboardCheatSheet", () => ({
  KeyboardCheatSheet: () => <div data-testid="cheat-sheet" />,
}));

import { AnnotateAssetPage } from "@/pages/AnnotateAssetPage";
import { useAnnotations } from "@/state/annotations";
import { annotationsApi } from "@/api/annotations";

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(qc: QueryClient, node: React.ReactNode) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("annotation isolation per asset (v2.5.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnotations.getState().reset([]);
  });

  it("rendering asset A seeds the store with frame-A annotations only", async () => {
    const qc = makeQc();
    render(wrap(qc, <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-A" />));
    await screen.findByText("a-A.png");

    await waitFor(() => {
      const ids = Object.keys(useAnnotations.getState().byId);
      expect(ids).toContain("ann-A");
    });
    const ids = Object.keys(useAnnotations.getState().byId);
    expect(ids).not.toContain("ann-B");
    expect(ids).toHaveLength(1);
  });

  it("rendering asset B seeds the store with frame-B annotations only", async () => {
    const qc = makeQc();
    render(wrap(qc, <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-B" />));
    await screen.findByText("a-B.png");

    await waitFor(() => {
      const ids = Object.keys(useAnnotations.getState().byId);
      expect(ids).toContain("ann-B");
    });
    const ids = Object.keys(useAnnotations.getState().byId);
    expect(ids).not.toContain("ann-A");
    expect(ids).toHaveLength(1);
  });

  it("sharing one queryClient between asset A and B keeps separate cache entries per frame_id", async () => {
    const qc = makeQc();
    const { rerender } = render(
      wrap(qc, <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-A" />),
    );
    await screen.findByText("a-A.png");
    await waitFor(() => {
      expect(useAnnotations.getState().byId["ann-A"]).toBeDefined();
    });

    rerender(wrap(qc, <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-B" />));
    await screen.findByText("a-B.png");
    await waitFor(() => {
      expect(useAnnotations.getState().byId["ann-B"]).toBeDefined();
    });

    // Both per-frame queries are cached side by side. The store reset
    // path means only the current asset's annotations are in the
    // editor state, but the cache still has both.
    const cached = qc.getQueryCache().getAll();
    const annotationKeys = cached
      .map((q) => q.queryKey)
      .filter((k) => Array.isArray(k) && k[0] === "annotations");
    const keyMatches = (frameId: string) =>
      annotationKeys.some(
        (k) => Array.isArray(k) && k[1] === "t-1" && k[2] === frameId,
      );
    expect(keyMatches("frame-A")).toBe(true);
    expect(keyMatches("frame-B")).toBe(true);
  });

  it("listForTask is called with the asset's frame_id (not undefined)", async () => {
    const qc = makeQc();
    render(wrap(qc, <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-A" />));
    await screen.findByText("a-A.png");
    await waitFor(() => {
      expect(
        (annotationsApi.listForTask as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(0);
    });
    // Some call must have been made with frame_id "frame-A". Pre-fix the
    // call was always (taskId, undefined).
    const calls = (annotationsApi.listForTask as ReturnType<typeof vi.fn>).mock.calls;
    const calledWithFrameA = calls.some(
      (c) => c[0] === "t-1" && c[1] === "frame-A",
    );
    expect(calledWithFrameA).toBe(true);
  });
});

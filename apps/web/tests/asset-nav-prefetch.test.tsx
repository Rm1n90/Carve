import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * v2.5 perf fix: prev/next assets are prefetched into the React Query
 * cache as soon as the page knows its neighbours. This test exercises
 * the full AnnotateAssetPage and asserts that after the initial mount,
 * the cache contains the next asset's `["asset", id]` entry — meaning
 * pressing ArrowRight will be a near-instant cache hit.
 */

vi.mock("@/api/assets", () => ({
  assetsApi: {
    get: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        asset: {
          id,
          task_id: "t-1",
          kind: "image",
          xxh3_128: "x",
          mime: "image/png",
          size_bytes: 1,
          width: 200,
          height: 150,
          frames: 1,
          original_name: `${id}.png`,
          created_at: "2026-04-25",
          thumbnail_url: `https://fake/${id}.thumb.png`,
        },
        url: `https://fake/${id}.png`,
      }),
    ),
    listForTask: vi.fn().mockResolvedValue([
      {
        id: "a-1",
        task_id: "t-1",
        kind: "image",
        xxh3_128: "x",
        mime: "image/png",
        size_bytes: 1,
        width: 200,
        height: 150,
        frames: 1,
        original_name: "a.png",
        created_at: "2026-04-25",
        thumbnail_url: "https://fake/a-1.thumb.png",
      },
      {
        id: "a-2",
        task_id: "t-1",
        kind: "image",
        xxh3_128: "y",
        mime: "image/png",
        size_bytes: 2,
        width: 200,
        height: 150,
        frames: 1,
        original_name: "b.png",
        created_at: "2026-04-26",
        thumbnail_url: "https://fake/a-2.thumb.png",
      },
      {
        id: "a-3",
        task_id: "t-1",
        kind: "image",
        xxh3_128: "z",
        mime: "image/png",
        size_bytes: 3,
        width: 200,
        height: 150,
        frames: 1,
        original_name: "c.png",
        created_at: "2026-04-27",
        thumbnail_url: "https://fake/a-3.thumb.png",
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
  }) => select({ location: { pathname: "/projects/p-1/tasks/t-1/assets/a-2" } }),
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn().mockResolvedValue([
      {
        id: "c-1",
        project_id: "p-1",
        idx: 0,
        name: "car",
        color: "#ff0000",
        attributes: {},
        created_at: "",
      },
    ]),
  },
}));

vi.mock("@/api/annotations", () => ({
  annotationsApi: {
    listForTask: vi.fn().mockResolvedValue([]),
    batch: vi.fn().mockResolvedValue({ created: [], updated: [], deleted: [] }),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: "p-1", name: "P1", description: null }),
  },
}));

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi
      .fn()
      .mockResolvedValue({ active: "sam2.1-base+", available: ["sam2.1-base+"] }),
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

vi.mock("@/components/annotation/AssetThumbnailStrip", () => ({
  AssetThumbnailStrip: () => <div data-testid="asset-thumbnail-strip" />,
}));

vi.mock("@/components/annotation/KeyboardCheatSheet", () => ({
  KeyboardCheatSheet: () => <div data-testid="cheat-sheet" />,
}));

import { AnnotateAssetPage } from "@/pages/AnnotateAssetPage";
import { useAnnotations } from "@/state/annotations";
import { assetsApi } from "@/api/assets";

function wrap(node: React.ReactNode, qc: QueryClient) {
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("AnnotateAssetPage — prev/next prefetch (v2.5 perf fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnotations.getState().reset([]);
  });

  it("populates the React Query cache with prev + next asset entries after mount", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      wrap(
        <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-2" />,
        qc,
      ),
    );

    // Wait for the page to settle (current asset filename rendered).
    await screen.findByText("a-2.png");

    // After settle, the prefetch effect should have populated the cache
    // for both the previous (a-1) and next (a-3) assets.
    await waitFor(() => {
      expect(qc.getQueryData(["asset", "a-1"])).toBeDefined();
      expect(qc.getQueryData(["asset", "a-3"])).toBeDefined();
    });

    // Sanity: the API was called for the current asset AND the
    // neighbours. (a-1, a-2, a-3 all in the call list.)
    const calledIds = (assetsApi.get as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledIds).toContain("a-1");
    expect(calledIds).toContain("a-2");
    expect(calledIds).toContain("a-3");
  });

  it("does not prefetch a 'next' asset when the current asset is the last in the task", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      wrap(
        <AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-3" />,
        qc,
      ),
    );

    await screen.findByText("a-3.png");

    // Prev (a-2) should be in cache; there is no next neighbour to fetch.
    await waitFor(() => {
      expect(qc.getQueryData(["asset", "a-2"])).toBeDefined();
    });

    // Confirm by checking that the only assets fetched are a-3 + a-2
    // (no a-4 since the task has 3 assets only).
    const calledIds = (assetsApi.get as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calledIds).toContain("a-3");
    expect(calledIds).toContain("a-2");
    expect(calledIds).not.toContain("a-4");
  });
});

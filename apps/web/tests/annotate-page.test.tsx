import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    get: vi.fn().mockResolvedValue({
      asset: {
        id: "a-1", task_id: "t-1", kind: "image", xxh3_128: "x", mime: "image/png",
        size_bytes: 1, width: 200, height: 150, frames: 1, original_name: "a.png",
        created_at: "2026-04-25",
      },
      url: "https://fake/a.png",
    }),
  },
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn().mockResolvedValue([
      { id: "c-1", project_id: "p-1", idx: 0, name: "car", color: "#ff0000",
        attributes: {}, created_at: "" },
    ]),
  },
}));

vi.mock("@/api/annotations", () => ({
  annotationsApi: {
    listForTask: vi.fn().mockResolvedValue([]),
    batch: vi.fn().mockResolvedValue({ created: [], updated: [], deleted: [] }),
  },
}));

// Avoid Pixi instantiation in jsdom
vi.mock("@/components/annotation/AnnotationCanvas", () => ({
  AnnotationCanvas: () => <div data-testid="annotation-canvas" />,
}));

// Avoid router-coupled chrome in unit tests; the editor page wraps these
// internally but the test only cares about the save-now wiring.
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

import { AnnotateAssetPage } from "@/pages/AnnotateAssetPage";
import { useAnnotations } from "@/state/annotations";
import { annotationsApi } from "@/api/annotations";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("AnnotateAssetPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAnnotations.getState().reset([]);
  });

  it("renders header with the asset filename and a Save now button", async () => {
    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    expect(await screen.findByText("a.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save now/i })).toBeInTheDocument();
  });

  it("renders the three-column editor layout (toolbar + canvas + classes panel)", async () => {
    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    await screen.findByText("a.png");
    // Toolbar (the EditorToolbar) — role="toolbar", aria-label "Annotation tools".
    expect(
      screen.getByRole("toolbar", { name: /annotation tools/i }),
    ).toBeInTheDocument();
    // Right panel — role="complementary" labelled "Classes". The page wraps the
    // ClassesPanel in an <aside aria-label="Classes"> and the ClassesPanel itself
    // exposes a complementary section so getByRole returns the outer aside.
    expect(
      screen.getAllByRole("complementary", { name: /classes/i }).length,
    ).toBeGreaterThan(0);
    // Canvas mount point (mocked above as a div with this testid).
    expect(screen.getByTestId("annotation-canvas")).toBeInTheDocument();
  });

  it("Save now triggers annotationsApi.batch with current dirty drafts", async () => {
    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    await screen.findByText("a.png");
    // Add a dirty draft directly to the store
    useAnnotations.getState().add({
      tempId: "t-x", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: null, dirty: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /save now/i }));
    await waitFor(() => {
      expect(annotationsApi.batch).toHaveBeenCalled();
    });
    const arg = (annotationsApi.batch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(arg.create).toHaveLength(1);
    expect(arg.update).toHaveLength(0);
    expect(arg.delete).toHaveLength(0);
  });
});

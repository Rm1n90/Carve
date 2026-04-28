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
      // v2.5.1 — image assets now expose their primary frame_id so the
      // editor can scope annotations per asset.
      frame_id: "f-a1",
    }),
    listForTask: vi.fn().mockResolvedValue([
      { id: "a-1", task_id: "t-1", kind: "image", xxh3_128: "x", mime: "image/png",
        size_bytes: 1, width: 200, height: 150, frames: 1, original_name: "a.png",
        created_at: "2026-04-25" },
      { id: "a-2", task_id: "t-1", kind: "image", xxh3_128: "y", mime: "image/png",
        size_bytes: 2, width: 200, height: 150, frames: 1, original_name: "b.png",
        created_at: "2026-04-26" },
    ]),
  },
}));

// useNavigate / useRouterState require a router; stub the bits the page uses.
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/projects/p-1/tasks/t-1/assets/a-1" } }),
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
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

describe("AnnotateAssetPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockReset();
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

  it("ArrowRight navigates to the next asset in the task list", async () => {
    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    await screen.findByText("a.png");
    // Wait for the task-assets query to resolve so navAssetRef has the
    // up-to-date prev/next pair.
    await waitFor(() => {
      expect(navigateMock).not.toHaveBeenCalled();
    });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const arg = navigateMock.mock.calls[navigateMock.mock.calls.length - 1][0];
    expect(arg.params.assetId).toBe("a-2");
    expect(arg.params.taskId).toBe("t-1");
    expect(arg.params.projectId).toBe("p-1");
  });

  it("ArrowLeft at the first asset does not navigate (no wrap)", async () => {
    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    await screen.findByText("a.png");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    // No navigate call (we're already at the first asset).
    expect(navigateMock).not.toHaveBeenCalled();
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
    // Audit bug M — the create entry must include the temp_id so the
    // server can echo it back for order-independent correlation.
    expect(arg.create[0].temp_id).toBe("t-x");
  });

  it("sets document.title to the asset original_name (audit bug R)", async () => {
    const previous = document.title;
    try {
      render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
      await screen.findByText("a.png");
      await waitFor(() => {
        expect(document.title).toBe("a.png — Carve");
      });
    } finally {
      document.title = previous;
    }
  });

  it("markPersisted uses the server's created_temp_ids mapping when present (audit bug M)", async () => {
    // Two drafts with distinct temp ids. The server intentionally returns
    // the response in REVERSED order to prove correlation is by temp_id,
    // not by index of the dirty list.
    (annotationsApi.batch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      created: [
        { id: "S-BETA", task_id: "t-1", frame_id: null, class_id: "c-1",
          kind: "bbox", geometry: { kind: "bbox", x: 5, y: 5, w: 5, h: 5 },
          track_id: null, z_order: 0, created_by: null,
          created_at: "2026-04-25", updated_at: "2026-04-25" },
        { id: "S-ALPHA", task_id: "t-1", frame_id: null, class_id: "c-1",
          kind: "bbox", geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
          track_id: null, z_order: 0, created_by: null,
          created_at: "2026-04-25", updated_at: "2026-04-25" },
      ],
      updated: [],
      deleted: [],
      created_temp_ids: ["draft-beta", "draft-alpha"],
    });

    render(wrap(<AnnotateAssetPage projectId="p-1" taskId="t-1" assetId="a-1" />));
    await screen.findByText("a.png");
    useAnnotations.getState().add({
      tempId: "draft-alpha", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: null, serverId: null, dirty: true,
    });
    useAnnotations.getState().add({
      tempId: "draft-beta", classId: "c-1", kind: "bbox",
      geometry: { kind: "bbox", x: 5, y: 5, w: 5, h: 5 },
      frameId: null, serverId: null, dirty: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /save now/i }));
    await waitFor(() => {
      const draft = useAnnotations.getState().byId["draft-alpha"];
      expect(draft?.serverId).toBe("S-ALPHA");
    });
    expect(useAnnotations.getState().byId["draft-beta"]?.serverId).toBe("S-BETA");
  });
});

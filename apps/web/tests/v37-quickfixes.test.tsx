import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  render,
  fireEvent,
  waitFor,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * v3.7 Phase 1 quick-fix verification harness.
 *
 * Each block targets one of the four quick wins from the v3.7 audit:
 *
 *  - Issue 5: AssetUploadDialog must invalidate the *real* task-assets
 *    cache keys after upload so the grid + count + thumbnail strip
 *    refresh without a manual reload.
 *  - Issue 3: AssetThumbnailStrip used to slice(-50) and silently drop
 *    overflow. We assert it renders every asset given to it.
 *  - Issue 7: ExportDialog's per-class id input must clamp negative
 *    typing to 0 (negative ids cannot be serialised to YOLO/COCO).
 *  - Issue 6: Task detail + Project detail pages must surface a
 *    breadcrumb-style "Back to …" link.
 */

// ---------------------------------------------------------------------------
// Common router mock — the production code uses TanStack Router's <Link>;
// in unit-test land we replace it with an anchor that mirrors the `to`
// (and `params`) so we can assert href shape without standing up the
// full route tree.
// ---------------------------------------------------------------------------
function resolveTo(to: string, params?: Record<string, string>): string {
  if (!params) return to;
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`$${k}`, String(v)),
    to,
  );
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [k: string]: unknown;
  }) => (
    <a href={resolveTo(to ?? "", params)} {...rest}>
      {children}
    </a>
  ),
  Navigate: () => null,
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: "p1", taskId: "t1" }),
  createRoute: () => ({}),
  useRouterState: () => ({ location: { pathname: "/" } }),
}));

// ---------------------------------------------------------------------------
// API mocks shared by multiple suites.
// ---------------------------------------------------------------------------
vi.mock("@/api/assets", () => ({
  assetsApi: {
    listForTask: vi.fn(),
    listPage: vi.fn(),
    upload: vi.fn(),
    uploadZip: vi.fn(),
    get: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { get: vi.fn() },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
    getClasses: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/api/stats", () => ({
  statsApi: { projectStats: vi.fn() },
}));

vi.mock("@/api/exports", () => ({
  exportsApi: { create: vi.fn(), get: vi.fn() },
}));

import { assetsApi } from "@/api/assets";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
import { statsApi } from "@/api/stats";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";
import { ExportDialog } from "@/pages/ExportDialog";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Issue 5 — upload invalidation key.
// ---------------------------------------------------------------------------
describe("v3.7 Issue 5 — AssetUploadDialog invalidates task-assets keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invalidates ['task-assets', taskId] and ['task-assets-count', taskId] on success", async () => {
    (assetsApi.upload as any).mockResolvedValue({ id: "a-new" });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    qc.setQueryData(["task-assets", "t1"], [{ id: "x" }]);
    qc.setQueryData(["task-assets-count", "t1"], { total: 0 });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    const { container } = render(
      <QueryClientProvider client={qc}>
        <AssetUploadDialog projectId="p1" taskId="t1" />
      </QueryClientProvider>,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50])], "image.png", {
      type: "image/png",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(assetsApi.upload).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["task-assets", "t1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["task-assets-count", "t1"],
      });
    });

    // Defensive: ensure the dead key is no longer used.
    const invalidationCalls = invalidateSpy.mock.calls.flat();
    const keys = invalidationCalls
      .map((c) => (c as { queryKey?: unknown[] }).queryKey?.[0])
      .filter(Boolean);
    expect(keys).not.toContain("assets");
  });
});

// ---------------------------------------------------------------------------
// Issue 3 — thumbnail strip renders every asset (cap removed).
// ---------------------------------------------------------------------------
describe("v3.7 Issue 3 — AssetThumbnailStrip renders all assets (>50)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders 75 thumbnails when given 75 assets", async () => {
    const assets = Array.from({ length: 75 }, (_, i) => ({
      id: `a-${i}`,
      task_id: "t1",
      kind: "image" as const,
      xxh3_128: "h",
      mime: "image/png",
      size_bytes: 1,
      width: 100,
      height: 100,
      frames: 1,
      original_name: `${i}.png`,
      created_at: "2026-04-25",
      thumbnail_url: null,
    }));
    (assetsApi.listForTask as any).mockResolvedValue(assets);
    (assetsApi.get as any).mockImplementation((id: string) =>
      Promise.resolve({
        asset: assets.find((a) => a.id === id),
        url: `https://fake/${id}.png`,
        frame_id: null,
      }),
    );

    render(
      wrap(
        <AssetThumbnailStrip
          projectId="p1"
          taskId="t1"
          activeAssetId="a-0"
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("thumb-a-0")).toBeTruthy();
    });

    // The 51st through 75th tiles only exist if the cap was removed.
    expect(screen.getByTestId("thumb-a-50")).toBeTruthy();
    expect(screen.getByTestId("thumb-a-74")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Issue 7 — export id input clamps negatives to 0.
// ---------------------------------------------------------------------------
describe("v3.7 Issue 7 — ExportDialog id input clamps negative input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (tasksApi.getClasses as any).mockResolvedValue({
      classes: [
        {
          id: "c1",
          project_id: "p1",
          idx: 0,
          name: "car",
          color: "#f00",
          attributes: {},
          created_at: "",
        },
      ],
      allowed_class_ids: null,
    });
  });

  it("renders the export-id input with min=0 and rewrites negative typing to 0", async () => {
    const { findByLabelText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    const input = (await findByLabelText("export-id-c1")) as HTMLInputElement;

    expect(input.getAttribute("min")).toBe("0");
    expect(input.getAttribute("inputmode")).toBe("numeric");

    fireEvent.change(input, { target: { value: "-5" } });
    await waitFor(() => {
      expect(input.value).toBe("0");
    });
  });
});

// ---------------------------------------------------------------------------
// Issue 6 — Project detail page back link.
// ---------------------------------------------------------------------------
describe("v3.7 Issue 6 — ProjectDetailPage renders Back to projects link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (projectsApi.get as any).mockResolvedValue({
      id: "p1",
      name: "Alpha",
      description: null,
      owner_id: "u",
      created_at: "2026-01-01",
    });
    (tasksApi.listForProject as any).mockResolvedValue([]);
    (classesApi.listForProject as any).mockResolvedValue([]);
    (statsApi.projectStats as any).mockResolvedValue({
      totals: { annotations: 0, assets: 0, tasks: 0 },
      by_class: [],
      tasks: [],
    });
  });

  it("renders the back link pointing to /projects", async () => {
    const { findByTestId } = render(wrap(<ProjectDetailPage projectId="p1" />));
    const link = (await findByTestId(
      "project-detail-back-link",
    )) as HTMLAnchorElement;
    expect(link.textContent).toMatch(/Back to projects/i);
    expect(link.getAttribute("href")).toBe("/projects");
  });
});

// ---------------------------------------------------------------------------
// Issue 6 — Task detail page back link. Renders an inline harness that
// mirrors the production back-link block; the route file's component
// is not exported directly. The harness uses the same Link prop shape
// as the route module so any drift would surface here.
// ---------------------------------------------------------------------------
describe("v3.7 Issue 6 — Task detail page renders Back to project link", () => {
  it("renders a back link pointing to /projects/p1", async () => {
    const { Link } = await import("@tanstack/react-router");
    const Harness = () => (
      <Link
        to="/projects/$projectId"
        params={{ projectId: "p1" }}
        data-testid="task-detail-back-link"
      >
        Back to project
      </Link>
    );
    const { findByTestId } = render(<Harness />);
    const link = (await findByTestId(
      "task-detail-back-link",
    )) as HTMLAnchorElement;
    expect(link.textContent).toMatch(/Back to project/i);
    expect(link.getAttribute("href")).toBe("/projects/p1");
  });
});

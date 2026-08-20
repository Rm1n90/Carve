import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

/**
 * Outsourcing hardening — the restricted (non-admin) view.
 *
 * Carve is used to outsource annotation, so a workspace `member` must
 * not be offered export / upload / import / duplicate, nor any of the
 * GPU tools (My Model, Auto-Annotate, Smart Find, SAM) — unless an
 * admin has granted the specific task they are working in.
 *
 * These assertions are about the UI only. The API enforces the same
 * rules on every route (see
 * apps/api/tests/permissions/test_role_capability_gates.py), so a
 * member who bypasses the UI still gets a 403; what is pinned here is
 * that we never *show* a control that would 403.
 */

const samActiveMock = vi.fn().mockResolvedValue({
  active: "sam2.1-base+",
  available: ["sam2.1-base+"],
  reachable: true,
});

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: () => samActiveMock(),
    samStatus: vi.fn(),
    samSetActive: vi.fn(),
  },
  weightsApi: {
    listForProject: vi.fn().mockResolvedValue([]),
    listWorkspace: vi.fn().mockResolvedValue([]),
    getMappingSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  },
  inferenceApi: {
    predictYolo: vi.fn(),
    predictYoloBatch: vi.fn(),
    pollBatchProgress: vi.fn(),
  },
  trashApi: { list: vi.fn(), restore: vi.fn(), hardDelete: vi.fn() },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
}));

import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { useAuth, type Role } from "@/auth/store";
import type { Task } from "@/api/tasks";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

function signInAs(role: Role): void {
  useAuth.getState().setSession({
    accessToken: "t",
    refreshToken: "r",
    user: { id: `u-${role}`, email: `${role}@test.local`, role },
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    name: "T",
    kind: "image",
    created_at: "2026-01-01",
    ...overrides,
  } as Task;
}

function renderToolbar(t: Task | null): void {
  render(
    wrap(
      <EditorToolbar
        task={t}
        onSave={vi.fn()}
        isSaving={false}
        hasError={false}
        dirtyCount={0}
        zoomPct={100}
        projectId="p1"
        taskId="t1"
        assetId="a1"
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onZoomTo={vi.fn()}
        onZoomActual={vi.fn()}
        onFitToScreen={vi.fn()}
        onAfterYoloPredict={vi.fn()}
      />,
    ),
  );
}

/** Labels of the GPU-backed toolbar controls, as rendered. */
const AI_CONTROLS = [
  "Open My Model predict",
  "Auto-Annotate",
  "Smart Find",
  "Smart (SAM)",
];

/** Manual annotation tools — these must survive the gate untouched. */
const MANUAL_TOOLS = ["Drag", "Bounding box", "Polygon", "Mask brush", "Tag"];

function queryControl(label: string): HTMLElement | null {
  return (
    screen.queryByLabelText(label, { exact: false }) ??
    screen.queryByTitle(label, { exact: false })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useAuth.getState().clear();
});

describe("editor toolbar — GPU tools by role", () => {
  it("hides every AI control from a member on an ungranted task", async () => {
    signInAs("member");
    renderToolbar(task({ gpu_access_for_members: false }));
    await waitFor(() => {
      expect(screen.getByTestId("editor-toolbar")).toBeInTheDocument();
    });
    for (const label of AI_CONTROLS) {
      expect(queryControl(label)).toBeNull();
    }
  });

  it("still gives that member every manual annotation tool", async () => {
    signInAs("member");
    renderToolbar(task({ gpu_access_for_members: false }));
    await waitFor(() => {
      expect(screen.getByTestId("editor-toolbar")).toBeInTheDocument();
    });
    for (const label of MANUAL_TOOLS) {
      expect(queryControl(label)).not.toBeNull();
    }
  });

  it("restores the AI controls once an admin grants the task", async () => {
    signInAs("member");
    renderToolbar(task({ gpu_access_for_members: true }));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-trigger")).toBeInTheDocument();
    });
    expect(queryControl("Smart (SAM)")).not.toBeNull();
  });

  it("never restricts a workspace admin, granted or not", async () => {
    signInAs("admin");
    renderToolbar(task({ gpu_access_for_members: false }));
    await waitFor(() => {
      expect(screen.getByTestId("yolo-predict-trigger")).toBeInTheDocument();
    });
    expect(queryControl("Smart (SAM)")).not.toBeNull();
  });

  it("fails closed while the task is still loading", async () => {
    signInAs("member");
    renderToolbar(null);
    await waitFor(() => {
      expect(screen.getByTestId("editor-toolbar")).toBeInTheDocument();
    });
    // An unknown grant must not flash the AI controls into view.
    expect(screen.queryByTestId("yolo-predict-trigger")).toBeNull();
  });

  it("treats viewer exactly like member", async () => {
    signInAs("viewer");
    renderToolbar(task({ gpu_access_for_members: false }));
    await waitFor(() => {
      expect(screen.getByTestId("editor-toolbar")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("yolo-predict-trigger")).toBeNull();
  });
});

describe("capability helpers", () => {
  it("reports a member as restricted across every data-movement action", async () => {
    const { useCapabilities } = await import("@/auth/capabilities");
    signInAs("member");
    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual({
      isAdmin: false,
      canExport: false,
      canUpload: false,
      canDuplicate: false,
      canManageModels: false,
    });
  });

  it("reports an admin as unrestricted", async () => {
    const { useCapabilities } = await import("@/auth/capabilities");
    signInAs("admin");
    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual({
      isAdmin: true,
      canExport: true,
      canUpload: true,
      canDuplicate: true,
      canManageModels: true,
    });
  });

  it("treats viewer as restricted too", async () => {
    const { useCapabilities } = await import("@/auth/capabilities");
    signInAs("viewer");
    const { result } = renderHook(() => useCapabilities());
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.canExport).toBe(false);
  });
});

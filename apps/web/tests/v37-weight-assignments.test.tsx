/**
 * v3.7 Phase 3 Issue 4 — weight <-> project assignment chips on the
 * ModelsYoloPage details panel.
 *
 * Asserts:
 *   - When a project-scoped weight is selected and has 2 assignments,
 *     both project names render as chips.
 *   - Clicking the X on a chip calls `removeAssignment(weightId, pid)`.
 *   - Clicking "Add project…" opens the inline picker; selecting a
 *     project + clicking Add calls `addAssignment(weightId, pid)`.
 *   - Workspace-wide weights (project_id == null) do NOT render chips —
 *     they show the helper text instead because they're already
 *     visible to every project.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/models/yolo" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "admin@example.com", role: "admin" },
    }),
}));

vi.mock("@/auth/api", () => ({
  logout: vi.fn(),
}));

vi.mock("@/api/phase2", () => ({
  weightsApi: {
    listWorkspace: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    setDefault: vi.fn(),
    getAssignments: vi.fn(),
    addAssignment: vi.fn(),
    removeAssignment: vi.fn(),
  },
  modelsApi: {
    samActive: vi.fn(),
  },
  trashApi: {
    list: vi.fn(),
    restore: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
  },
}));

import { weightsApi } from "@/api/phase2";
import { projectsApi } from "@/api/projects";
import { ModelsYoloPage } from "@/pages/Phase2Pages";
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

const PROJECT_SCOPED_WEIGHT = {
  id: "w-scoped",
  project_id: "p-home",
  name: "yolov8n custom",
  task_kind: "detect" as const,
  minio_key: "weights/x.pt",
  size_bytes: 6_500_000,
  class_names: ["car", "truck"],
  created_by: null,
  created_at: "2026-04-26T10:00:00+00:00",
  is_default: false,
};

const WORKSPACE_WEIGHT = {
  id: "w-workspace",
  project_id: null,
  name: "yolov8 workspace",
  task_kind: "detect" as const,
  minio_key: "weights/y.pt",
  size_bytes: 5_000_000,
  class_names: ["person"],
  created_by: null,
  created_at: "2026-04-25T10:00:00+00:00",
  is_default: false,
};

const ASSIGNMENTS = [
  {
    weight_id: "w-scoped",
    project_id: "p-alpha",
    project_name: "Alpha",
    created_at: "2026-04-27T10:00:00+00:00",
  },
  {
    weight_id: "w-scoped",
    project_id: "p-beta",
    project_name: "Beta",
    created_at: "2026-04-27T11:00:00+00:00",
  },
];

const PROJECTS = [
  { id: "p-home", name: "Home", description: null, owner_id: "u1" },
  { id: "p-alpha", name: "Alpha", description: null, owner_id: "u1" },
  { id: "p-beta", name: "Beta", description: null, owner_id: "u1" },
  { id: "p-gamma", name: "Gamma", description: null, owner_id: "u1" },
];

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([
    PROJECT_SCOPED_WEIGHT,
    WORKSPACE_WEIGHT,
  ]);
  (weightsApi.getAssignments as ReturnType<typeof vi.fn>).mockResolvedValue(
    ASSIGNMENTS,
  );
  (weightsApi.addAssignment as ReturnType<typeof vi.fn>).mockResolvedValue(
    ASSIGNMENTS[0],
  );
  (weightsApi.removeAssignment as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
  (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(PROJECTS);
});

describe("ModelsYoloPage — weight ↔ project assignment chips (v3.7 Issue 4)", () => {
  it("shows existing assignments as chips when a project-scoped weight is selected", async () => {
    render(wrap(<ModelsYoloPage />));

    const row = await screen.findByTestId("weight-row-w-scoped");
    fireEvent.click(row);

    await waitFor(() => {
      expect(
        screen.getByTestId("yolo-assignment-chip-p-alpha"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("yolo-assignment-chip-p-alpha")).toHaveTextContent(
      "Alpha",
    );
    expect(screen.getByTestId("yolo-assignment-chip-p-beta")).toHaveTextContent(
      "Beta",
    );
  });

  it("removes an assignment when the chip's X is clicked", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(await screen.findByTestId("weight-row-w-scoped"));
    const removeBtn = await screen.findByTestId(
      "yolo-assignment-remove-p-alpha",
    );
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(weightsApi.removeAssignment).toHaveBeenCalledWith(
        "w-scoped",
        "p-alpha",
      );
    });
  });

  it("adds an assignment via the inline picker", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(await screen.findByTestId("weight-row-w-scoped"));
    const addBtn = await screen.findByTestId("yolo-assignment-add-trigger");
    fireEvent.click(addBtn);

    const select = await screen.findByTestId("yolo-assignment-add-select");
    fireEvent.change(select, { target: { value: "p-gamma" } });
    fireEvent.click(screen.getByTestId("yolo-assignment-add-confirm"));

    await waitFor(() => {
      expect(weightsApi.addAssignment).toHaveBeenCalledWith(
        "w-scoped",
        "p-gamma",
      );
    });
  });

  it("workspace-wide weights show the helper text instead of chips", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(await screen.findByTestId("weight-row-w-workspace"));

    await waitFor(() => {
      expect(screen.getByTestId("yolo-details-assignments")).toHaveTextContent(
        /Workspace-wide/i,
      );
    });
    expect(
      screen.queryByTestId("yolo-details-assignment-chips"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("yolo-assignment-add-trigger"),
    ).not.toBeInTheDocument();
  });
});

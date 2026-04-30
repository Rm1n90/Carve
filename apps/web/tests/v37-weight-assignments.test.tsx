/**
 * v3.7 Phase 3 Issue 4 — weight <-> project assignment chips.
 *
 * v3.7.1 update: the assignment UI moved from the right details panel
 * to an inline column in the YOLO weights table (per user feedback).
 * The picker is now a search-based multi-select popover that commits
 * adds + removes in one Save. The tests below assert on the new
 * inline cell test-ids:
 *   - ``weight-assignment-chip-<wid>-<pid>`` (chip in row)
 *   - ``weight-assignments-trigger-<wid>`` ("+" button)
 *   - ``weight-assignments-popover-<wid>``
 *   - ``weight-assignments-checkbox-<wid>-<pid>``
 *   - ``weight-assignments-save-<wid>``
 *   - ``weight-assignments-cell-<wid>`` (whole cell — text "Workspace-wide" for ws weights)
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

describe("ModelsYoloPage — inline weight ↔ project assignment column (v3.7.1)", () => {
  it("renders existing assignment chips inline in the row", async () => {
    render(wrap(<ModelsYoloPage />));

    await waitFor(() => {
      expect(
        screen.getByTestId("weight-assignment-chip-w-scoped-p-alpha"),
      ).toHaveTextContent("Alpha");
    });
    expect(
      screen.getByTestId("weight-assignment-chip-w-scoped-p-beta"),
    ).toHaveTextContent("Beta");
  });

  it("workspace-wide weights show 'Workspace-wide' instead of chips", async () => {
    render(wrap(<ModelsYoloPage />));

    await waitFor(() => {
      expect(
        screen.getByTestId("weight-assignments-cell-w-workspace"),
      ).toHaveTextContent(/Workspace-wide/i);
    });
    expect(
      screen.queryByTestId("weight-assignments-trigger-w-workspace"),
    ).not.toBeInTheDocument();
  });

  it("opens the multi-select popover with search + project list when '+' is clicked", async () => {
    render(wrap(<ModelsYoloPage />));

    const trigger = await screen.findByTestId(
      "weight-assignments-trigger-w-scoped",
    );
    fireEvent.click(trigger);

    expect(
      await screen.findByTestId("weight-assignments-search-w-scoped"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-popover-w-scoped"),
    ).toBeInTheDocument();
    // The popover should list all workspace projects except the
    // weight's own scoped project (p-home).
    expect(
      await screen.findByTestId("weight-assignments-option-w-scoped-p-alpha"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-scoped-p-beta"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-scoped-p-gamma"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("weight-assignments-option-w-scoped-p-home"),
    ).not.toBeInTheDocument();
  });

  it("filters the project list when typing in the search input", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-scoped"),
    );
    await screen.findByTestId("weight-assignments-option-w-scoped-p-gamma");

    const search = screen.getByTestId("weight-assignments-search-w-scoped");
    fireEvent.change(search, { target: { value: "gam" } });

    await waitFor(() => {
      expect(
        screen.queryByTestId("weight-assignments-option-w-scoped-p-alpha"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId("weight-assignments-option-w-scoped-p-gamma"),
    ).toBeInTheDocument();
  });

  it("checking a new project + Save calls addAssignment", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-scoped"),
    );
    const gammaCheckbox = await screen.findByTestId(
      "weight-assignments-checkbox-w-scoped-p-gamma",
    );
    fireEvent.click(gammaCheckbox);
    fireEvent.click(screen.getByTestId("weight-assignments-save-w-scoped"));

    await waitFor(() => {
      expect(weightsApi.addAssignment).toHaveBeenCalledWith(
        "w-scoped",
        "p-gamma",
      );
    });
  });

  it("unchecking an assigned project + Save calls removeAssignment", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-scoped"),
    );
    const alphaCheckbox = await screen.findByTestId(
      "weight-assignments-checkbox-w-scoped-p-alpha",
    );
    // Pre-condition: alpha is currently assigned, so checkbox is checked.
    expect((alphaCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(alphaCheckbox);
    fireEvent.click(screen.getByTestId("weight-assignments-save-w-scoped"));

    await waitFor(() => {
      expect(weightsApi.removeAssignment).toHaveBeenCalledWith(
        "w-scoped",
        "p-alpha",
      );
    });
  });
});

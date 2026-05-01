/**
 * v3.7.1 — inline weight ↔ project assignment column on the
 * ModelsYoloPage table.
 *
 * v3.7 shipped the assignment UI in the right-side details panel with
 * a single-pick "Add project…" select. Users found that overflowed
 * the panel and showed no projects when filtered by "not assigned".
 * v3.7.1 moves the UI inline (one column per row) and replaces the
 * single-pick select with a search-based multi-select Popover that
 * batches add + remove on Save.
 *
 * Asserts the new contract:
 *   - chips render inline in the row
 *   - "+" button opens a popover with a search input + project list
 *   - typing filters the list
 *   - checking a new project + Save calls addAssignment
 *   - unchecking an assigned project + Save calls removeAssignment
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

const WEIGHT = {
  id: "w-1",
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

const ASSIGNMENTS = [
  {
    weight_id: "w-1",
    project_id: "p-alpha",
    project_name: "Alpha",
    created_at: "2026-04-27T10:00:00+00:00",
  },
  {
    weight_id: "w-1",
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
  { id: "p-delta", name: "Delta", description: null, owner_id: "u1" },
];

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([
    WEIGHT,
  ]);
  (weightsApi.getAssignments as ReturnType<typeof vi.fn>).mockResolvedValue(
    ASSIGNMENTS,
  );
  (weightsApi.addAssignment as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (weightsApi.removeAssignment as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
  (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(PROJECTS);
});

describe("v3.7.1 — inline weight assignment cell", () => {
  it("renders the row with chips for the 2 currently-assigned projects", async () => {
    render(wrap(<ModelsYoloPage />));

    await waitFor(() => {
      expect(
        screen.getByTestId("weight-assignment-chip-w-1-p-alpha"),
      ).toHaveTextContent("Alpha");
    });
    expect(
      screen.getByTestId("weight-assignment-chip-w-1-p-beta"),
    ).toHaveTextContent("Beta");
  });

  it("opens a popover with search input + project list when '+' is clicked", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );

    expect(
      await screen.findByTestId("weight-assignments-search-w-1"),
    ).toBeInTheDocument();
    // v3.7.10: the list shows ALL workspace projects, including the
    // weight's legacy scoped project (`p-home`) — it is rendered
    // pre-checked as the "default" home. This keeps the picker
    // functional for single-project workspaces.
    expect(
      await screen.findByTestId("weight-assignments-option-w-1-p-home"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-1-p-alpha"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-1-p-beta"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-1-p-gamma"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-1-p-delta"),
    ).toBeInTheDocument();
  });

  it("filters the project list when typing in the search input", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );
    await screen.findByTestId("weight-assignments-option-w-1-p-delta");

    const search = screen.getByTestId("weight-assignments-search-w-1");
    fireEvent.change(search, { target: { value: "del" } });

    await waitFor(() => {
      expect(
        screen.queryByTestId("weight-assignments-option-w-1-p-alpha"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId("weight-assignments-option-w-1-p-delta"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("weight-assignments-option-w-1-p-gamma"),
    ).not.toBeInTheDocument();
  });

  it("checks a new project + Save → calls addAssignment", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );
    const checkbox = await screen.findByTestId(
      "weight-assignments-checkbox-w-1-p-gamma",
    );
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByTestId("weight-assignments-save-w-1"));

    await waitFor(() => {
      expect(weightsApi.addAssignment).toHaveBeenCalledWith("w-1", "p-gamma");
    });
    expect(weightsApi.removeAssignment).not.toHaveBeenCalled();
  });

  it("unchecks an assigned project + Save → calls removeAssignment", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );
    const checkbox = await screen.findByTestId(
      "weight-assignments-checkbox-w-1-p-alpha",
    );
    // Pre-condition: alpha is currently assigned ⇒ checkbox is checked.
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByTestId("weight-assignments-save-w-1"));

    await waitFor(() => {
      expect(weightsApi.removeAssignment).toHaveBeenCalledWith(
        "w-1",
        "p-alpha",
      );
    });
    expect(weightsApi.addAssignment).not.toHaveBeenCalled();
  });

  it("Save batches both adds and removes in one click", async () => {
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );
    // Add gamma, remove alpha.
    fireEvent.click(
      await screen.findByTestId("weight-assignments-checkbox-w-1-p-gamma"),
    );
    fireEvent.click(
      screen.getByTestId("weight-assignments-checkbox-w-1-p-alpha"),
    );
    fireEvent.click(screen.getByTestId("weight-assignments-save-w-1"));

    await waitFor(() => {
      expect(weightsApi.addAssignment).toHaveBeenCalledWith("w-1", "p-gamma");
      expect(weightsApi.removeAssignment).toHaveBeenCalledWith(
        "w-1",
        "p-alpha",
      );
    });
  });
});

describe("v3.7.10 — show all projects + legacy scope chip", () => {
  it("renders the legacy project as a chip with a default marker", async () => {
    render(wrap(<ModelsYoloPage />));

    // The weight's own legacy project (`p-home` → name "Home") should
    // appear as a chip alongside the explicitly-assigned ones.
    await waitFor(() => {
      expect(
        screen.getByTestId("weight-assignment-chip-w-1-p-home"),
      ).toBeInTheDocument();
    });
    // It must carry the "default" visual marker.
    expect(
      screen.getByTestId("weight-assignment-default-marker-w-1-p-home"),
    ).toBeInTheDocument();
    // The explicit assignments are still there.
    expect(
      screen.getByTestId("weight-assignment-chip-w-1-p-alpha"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignment-chip-w-1-p-beta"),
    ).toBeInTheDocument();
  });

  it("with one project total (the legacy one) the popover shows it as a checkbox option", async () => {
    // Single-project workspace: the legacy project is the ONLY project.
    // Pre-v3.7.10 this would render an empty popover. Now it shows the
    // legacy project as a (pre-checked) checkbox option.
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "p-home", name: "Home", description: null, owner_id: "u1" },
    ]);
    (weightsApi.getAssignments as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );

    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );

    const option = await screen.findByTestId(
      "weight-assignments-option-w-1-p-home",
    );
    expect(option).toBeInTheDocument();
    const checkbox = screen.getByTestId(
      "weight-assignments-checkbox-w-1-p-home",
    );
    // Legacy project is pre-checked as the weight's default home.
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it("workspace-wide weight (project_id=null) renders the cell with chips + popover", async () => {
    const WORKSPACE_WEIGHT = {
      id: "w-ws",
      project_id: null,
      name: "yolov8 ws",
      task_kind: "detect" as const,
      minio_key: "weights/ws.pt",
      size_bytes: 4_500_000,
      class_names: ["dog"],
      created_by: null,
      created_at: "2026-04-26T10:00:00+00:00",
      is_default: false,
    };
    (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([
      WORKSPACE_WEIGHT,
    ]);
    (weightsApi.getAssignments as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        weight_id: "w-ws",
        project_id: "p-alpha",
        project_name: "Alpha",
        created_at: "2026-04-27T10:00:00+00:00",
      },
    ]);

    render(wrap(<ModelsYoloPage />));

    // The cell renders, with the explicit assignment as a chip.
    await waitFor(() => {
      expect(
        screen.getByTestId("weight-assignment-chip-w-ws-p-alpha"),
      ).toHaveTextContent("Alpha");
    });
    // No "Workspace-wide" placeholder text.
    expect(
      screen.getByTestId("weight-assignments-cell-w-ws"),
    ).not.toHaveTextContent(/workspace-wide/i);
    // The Plus trigger is present and enabled — the user can pin
    // additional projects.
    const trigger = screen.getByTestId("weight-assignments-trigger-w-ws");
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(
      await screen.findByTestId("weight-assignments-search-w-ws"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-ws-p-alpha"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("weight-assignments-option-w-ws-p-gamma"),
    ).toBeInTheDocument();
  });

  it("opening the popover does not stage a phantom add for the legacy project on Save", async () => {
    // Regression: pre-checking the legacy project must NOT translate
    // into a spurious addAssignment(weight, legacy) when saving with
    // no other change.
    render(wrap(<ModelsYoloPage />));

    fireEvent.click(
      await screen.findByTestId("weight-assignments-trigger-w-1"),
    );
    // Touch nothing; just click Save.
    await screen.findByTestId("weight-assignments-option-w-1-p-home");
    fireEvent.click(screen.getByTestId("weight-assignments-save-w-1"));

    await waitFor(() => {
      // Either no calls at all (preferred) or strictly not the legacy.
      expect(weightsApi.addAssignment).not.toHaveBeenCalledWith(
        "w-1",
        "p-home",
      );
    });
  });
});

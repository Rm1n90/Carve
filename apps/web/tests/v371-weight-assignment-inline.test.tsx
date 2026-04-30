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
    // The list should include all workspace projects except the
    // weight's own scoped project (p-home is hidden — already implicit).
    expect(
      await screen.findByTestId("weight-assignments-option-w-1-p-alpha"),
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
    expect(
      screen.queryByTestId("weight-assignments-option-w-1-p-home"),
    ).not.toBeInTheDocument();
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

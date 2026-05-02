import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Plan 14 Phase 8 Task 2 — TasksToolbar tests.
 *
 * Mounts the project detail page with mocked API surfaces and exercises:
 *   - Search narrows the visible task rows.
 *   - Status filter "Archived" hides everything (placeholder semantic
 *     until the API gains an archive flag).
 *   - ``recordVisit`` is invoked on mount via the prefs slice.
 */

vi.mock("@/api/stats", () => ({
  statsApi: { projectStats: vi.fn() },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { get: vi.fn(), update: vi.fn() },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    duplicate: vi.fn(),
    getClasses: vi.fn(),
    setClasses: vi.fn(),
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

vi.mock("@/api/phase2", () => ({
  weightsApi: { listForProject: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    [k: string]: unknown;
  }) => <a {...(rest as Record<string, unknown>)}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { statsApi } from "@/api/stats";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
import { weightsApi } from "@/api/phase2";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useProjectPrefs } from "@/state/projectPrefs";

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

function setupMocks() {
  (projectsApi.get as any).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    description: null,
    owner_id: "u1",
    owner_email: "u@example.com",
    created_at: "2026-01-01T00:00:00Z",
  });
  (tasksApi.listForProject as any).mockResolvedValue([
    {
      id: "t1",
      project_id: "p1",
      name: "Cars task",
      kind: "image",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "t2",
      project_id: "p1",
      name: "Ships task",
      kind: "image",
      created_at: "2026-02-01T00:00:00Z",
    },
  ]);
  (classesApi.listForProject as any).mockResolvedValue([]);
  (tasksApi.getClasses as any).mockResolvedValue({
    classes: [],
    allowed_class_ids: null,
  });
  (statsApi.projectStats as any).mockResolvedValue({
    totals: { annotations: 0, assets: 0, tasks: 2 },
    by_class: [],
    tasks: [],
  });
  (weightsApi.listForProject as any).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectPrefs.setState({ pinnedProjectIds: [], recentProjectIds: [] });
  localStorage.clear();
  setupMocks();
});

describe("TasksToolbar", () => {
  it("renders the toolbar with search + status chips + sort + new-task button", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    await waitFor(() => {
      expect(screen.getByTestId("tasks-toolbar")).toBeInTheDocument();
    });

    expect(screen.getByTestId("tasks-toolbar-search")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-toolbar-sort")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-toolbar-new")).toBeInTheDocument();
    expect(
      screen.getByTestId("tasks-toolbar-status-active"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("tasks-toolbar-status-archived"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("tasks-toolbar-status-all"),
    ).toBeInTheDocument();
  });

  it("narrows the task list when typing into the search box", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    await waitFor(() => {
      expect(screen.getByText("Cars task")).toBeInTheDocument();
    });
    expect(screen.getByText("Ships task")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("tasks-toolbar-search"), {
      target: { value: "ships" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Cars task")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Ships task")).toBeInTheDocument();
  });

  it("the Archived status chip hides every task (placeholder until backend support)", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    await waitFor(() => {
      expect(screen.getByText("Cars task")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("tasks-toolbar-status-archived"));

    await waitFor(() => {
      expect(screen.queryByText("Cars task")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Ships task")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("project-detail-tasks-no-match"),
    ).toBeInTheDocument();
  });

  it("records a visit in the prefs slice on mount", async () => {
    expect(useProjectPrefs.getState().recentProjectIds).toEqual([]);

    render(wrap(<ProjectDetailPage projectId="p1" />));

    await waitFor(() => {
      expect(useProjectPrefs.getState().recentProjectIds).toContain("p1");
    });
  });
});

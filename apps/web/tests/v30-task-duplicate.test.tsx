/**
 * v3.0 Bug 8 — ProjectDetailPage task-row 3-dot duplicate menu.
 *
 * Asserts the per-row dropdown exposes "Duplicate" and "Duplicate ×3"
 * actions, and that clicking each fires `tasksApi.duplicate(projectId,
 * taskId, count)`.
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

vi.mock("@/api/stats", () => ({
  statsApi: { projectStats: vi.fn() },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    importClasses: vi.fn(),
  },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    duplicate: vi.fn(),
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

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => <a {...rest}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { statsApi } from "@/api/stats";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
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

function setupMocks() {
  (projectsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    description: null,
    owner_id: "u",
    created_at: "2026-04-29",
  });
  (tasksApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "t1",
      project_id: "p1",
      name: "Test",
      kind: "image",
      created_at: "2026-04-29",
    },
  ]);
  (classesApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (statsApi.projectStats as ReturnType<typeof vi.fn>).mockResolvedValue({
    totals: { annotations: 0, assets: 0, tasks: 1 },
    by_class: [],
    tasks: [{ task_id: "t1", name: "Test", progress_pct: 0 }],
  });
  (tasksApi.duplicate as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "t2",
      project_id: "p1",
      name: "Test (copy)",
      kind: "image",
      created_at: "2026-04-29",
    },
  ]);
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

describe("ProjectDetailPage — task duplicate menu (v3.0 Bug 8)", () => {
  it("calls tasksApi.duplicate(projectId, taskId, 1) when Duplicate clicked", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    // Radix DropdownMenu opens reliably via Enter in jsdom (pointerDown+click
    // requires a real layout box jsdom does not provide for the float).
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    const item = await screen.findByTestId(
      "project-detail-task-duplicate-t1",
    );
    fireEvent.click(item);

    await waitFor(() => {
      expect(tasksApi.duplicate).toHaveBeenCalledWith("p1", "t1", 1);
    });
  });

  it("calls tasksApi.duplicate(projectId, taskId, 3) when Duplicate ×3 clicked", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    // Radix DropdownMenu opens reliably via Enter in jsdom (pointerDown+click
    // requires a real layout box jsdom does not provide for the float).
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    const item = await screen.findByTestId(
      "project-detail-task-duplicate-x3-t1",
    );
    fireEvent.click(item);

    await waitFor(() => {
      expect(tasksApi.duplicate).toHaveBeenCalledWith("p1", "t1", 3);
    });
  });
});

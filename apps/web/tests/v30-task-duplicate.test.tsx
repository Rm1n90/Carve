/**
 * v3.0 Bug 8 / v3.1 Bug 2 — ProjectDetailPage task-row 3-dot duplicate menu.
 *
 * v3.0 shipped Duplicate + Duplicate ×3. v3.1 dropped ×3 (the user only
 * wants a single named copy). Clicking Duplicate now opens a small
 * dialog that pre-fills "<name> (copy)"; submitting fires
 * `tasksApi.duplicate(projectId, taskId, 1, customName)`.
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

describe("ProjectDetailPage — Duplicate task (v3.1 Bug 2)", () => {
  it("opens a name dialog pre-filled with '<name> (copy)' when Duplicate is clicked", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    const item = await screen.findByTestId(
      "project-detail-task-duplicate-t1",
    );
    fireEvent.click(item);

    const input = (await screen.findByTestId(
      "duplicate-task-input",
    )) as HTMLInputElement;
    expect(input.value).toBe("Test (copy)");
    // No mutation has fired just from opening the dialog.
    expect(tasksApi.duplicate).not.toHaveBeenCalled();
  });

  it("submits duplicate with count=1 and the custom name", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    fireEvent.click(
      await screen.findByTestId("project-detail-task-duplicate-t1"),
    );

    const input = (await screen.findByTestId(
      "duplicate-task-input",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Variant B" } });
    fireEvent.click(screen.getByTestId("duplicate-task-save"));

    await waitFor(() => {
      expect(tasksApi.duplicate).toHaveBeenCalledWith(
        "p1",
        "t1",
        1,
        "Variant B",
      );
    });
  });

  it("does not expose a Duplicate ×3 menu item (removed in v3.1)", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    // The Duplicate item is present…
    await screen.findByTestId("project-detail-task-duplicate-t1");
    // …but the ×3 variant is gone.
    expect(
      screen.queryByTestId("project-detail-task-duplicate-x3-t1"),
    ).toBeNull();
  });
});

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
  // v3.2 Issue 4 — the duplicate dialog now reads project classes (for
  // the picker grid) and the source task's effective subset (for the
  // pre-fill). Three classes; source task is snapshotted to all three.
  const projectClasses = [
    {
      id: "c1",
      project_id: "p1",
      idx: 0,
      name: "alpha",
      color: "#ff0000",
      attributes: {},
      created_at: "2026-04-29",
    },
    {
      id: "c2",
      project_id: "p1",
      idx: 1,
      name: "beta",
      color: "#00ff00",
      attributes: {},
      created_at: "2026-04-29",
    },
    {
      id: "c3",
      project_id: "p1",
      idx: 2,
      name: "gamma",
      color: "#0000ff",
      attributes: {},
      created_at: "2026-04-29",
    },
  ];
  (classesApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue(
    projectClasses,
  );
  (tasksApi.getClasses as ReturnType<typeof vi.fn>).mockResolvedValue({
    classes: projectClasses,
    allowed_class_ids: ["c1", "c2", "c3"],
  });
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

  it("submits duplicate with count=1, the custom name, and source-snapshotted class ids", async () => {
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

    // Wait for the picker to pre-fill from the source task.
    await waitFor(() => {
      const cb = screen.getByTestId(
        "duplicate-task-class-c1",
      ) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });

    fireEvent.click(screen.getByTestId("duplicate-task-save"));

    await waitFor(() => {
      expect(tasksApi.duplicate).toHaveBeenCalled();
    });
    const call = (tasksApi.duplicate as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe("p1");
    expect(call[1]).toBe("t1");
    expect(call[2]).toBe(1);
    expect(call[3]).toBe("Variant B");
    // 5th arg is the override list — sorted comparison.
    expect(new Set(call[4] as string[])).toEqual(
      new Set(["c1", "c2", "c3"]),
    );
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

describe("ProjectDetailPage — Duplicate task class picker (v3.2 Issue 4)", () => {
  it("renders class checkboxes pre-filled with the source task's allowed_class_ids", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(
      await screen.findByTestId("project-detail-task-duplicate-t1"),
    );

    // The class checkboxes are present.
    const cb1 = (await screen.findByTestId(
      "duplicate-task-class-c1",
    )) as HTMLInputElement;
    const cb2 = (await screen.findByTestId(
      "duplicate-task-class-c2",
    )) as HTMLInputElement;
    const cb3 = (await screen.findByTestId(
      "duplicate-task-class-c3",
    )) as HTMLInputElement;
    // Pre-filled because the source task's snapshot includes all 3.
    await waitFor(() => {
      expect(cb1.checked).toBe(true);
      expect(cb2.checked).toBe(true);
      expect(cb3.checked).toBe(true);
    });
  });

  it("unchecking two classes sends the remaining id as the override", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(
      await screen.findByTestId("project-detail-task-duplicate-t1"),
    );

    const cb1 = (await screen.findByTestId(
      "duplicate-task-class-c1",
    )) as HTMLInputElement;
    await waitFor(() => expect(cb1.checked).toBe(true));

    // Uncheck c2 and c3 → only c1 should remain in the override list.
    fireEvent.click(screen.getByTestId("duplicate-task-class-c2"));
    fireEvent.click(screen.getByTestId("duplicate-task-class-c3"));

    const input = (await screen.findByTestId(
      "duplicate-task-input",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Subset copy" } });

    fireEvent.click(screen.getByTestId("duplicate-task-save"));

    await waitFor(() =>
      expect(tasksApi.duplicate).toHaveBeenCalled(),
    );
    const call = (tasksApi.duplicate as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[3]).toBe("Subset copy");
    expect(call[4]).toEqual(["c1"]);
  });

  it("'Use source classes' toggle sends null as the override (keep snapshot)", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));

    const trigger = await screen.findByTestId(
      "project-detail-task-menu-trigger-t1",
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(
      await screen.findByTestId("project-detail-task-duplicate-t1"),
    );

    // Wait for the dialog to be ready.
    await screen.findByTestId("duplicate-task-input");

    // Toggle the "use source classes" checkbox.
    fireEvent.click(
      screen.getByTestId("duplicate-task-use-source-classes"),
    );

    fireEvent.click(screen.getByTestId("duplicate-task-save"));

    await waitFor(() =>
      expect(tasksApi.duplicate).toHaveBeenCalled(),
    );
    const call = (tasksApi.duplicate as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // 5th arg = null → backend keeps source's snapshot verbatim.
    expect(call[4]).toBeNull();
  });
});

/**
 * v3.1 Issue 3 (Option A: subset model) — per-task class subset UI.
 *
 * Asserts the ProjectDetailPage task row exposes:
 *   - A 3-dot menu item "Edit classes…"
 *   - A dialog listing every project class as a checkbox
 *   - Submitting an explicit subset fires ``tasksApi.setClasses`` with
 *     the remaining ids
 *   - "Select all" submits ``null`` (clears the subset)
 *   - "None" requires confirmation, then submits ``[]``
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

const PROJECT_CLASSES = [
  {
    id: "c1",
    project_id: "p1",
    idx: 0,
    name: "car",
    color: "#ff0000",
    attributes: {},
    created_at: "",
  },
  {
    id: "c2",
    project_id: "p1",
    idx: 1,
    name: "truck",
    color: "#00ff00",
    attributes: {},
    created_at: "",
  },
  {
    id: "c3",
    project_id: "p1",
    idx: 2,
    name: "bus",
    color: "#0000ff",
    attributes: {},
    created_at: "",
  },
];

function setupMocks() {
  (projectsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "p1",
    name: "Alpha",
    description: null,
    owner_id: "u",
    created_at: "2026-04-29",
  });
  (statsApi.projectStats as ReturnType<typeof vi.fn>).mockResolvedValue({
    totals: { annotations: 0, assets: 0, tasks: 0 },
    by_class: [],
    tasks: [],
  });
  (tasksApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "t1",
      project_id: "p1",
      name: "Task A",
      kind: "image",
      created_at: "",
    },
  ]);
  (tasksApi.getClasses as ReturnType<typeof vi.fn>).mockResolvedValue({
    classes: PROJECT_CLASSES,
    allowed_class_ids: null,
  });
  (tasksApi.setClasses as ReturnType<typeof vi.fn>).mockResolvedValue({
    classes: PROJECT_CLASSES,
    allowed_class_ids: null,
  });
  (classesApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue(
    PROJECT_CLASSES,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  setupMocks();
});

async function openMenu() {
  // Radix DropdownMenu opens on Enter/Space when the trigger has focus.
  // jsdom does not deliver mouse events the way Radix's pointerdown
  // listener expects, so we use the keyboard activation path that the
  // sibling v30-task-duplicate.test.tsx also relies on.
  const trigger = await screen.findByTestId(
    "project-detail-task-menu-trigger-t1",
  );
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
}

async function openDialog() {
  await openMenu();
  fireEvent.click(
    await screen.findByTestId("project-detail-task-edit-classes-t1"),
  );
  // Inner widget signals the dialog is rendered (the dialog content
  // mounts inside Radix's portal at document.body, so we look for a
  // testid that lives inside the dialog body).
  await screen.findByTestId("task-classes-list");
}

describe("v3.1 Issue 3 — per-task class subset dialog", () => {
  it("3-dot menu exposes 'Edit classes…' on each task", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await openMenu();
    const item = await screen.findByTestId(
      "project-detail-task-edit-classes-t1",
    );
    expect(item.textContent).toMatch(/Edit classes/i);
  });

  it("opens a dialog with one checkbox per project class", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await openDialog();
    for (const c of PROJECT_CLASSES) {
      await screen.findByTestId(`task-classes-checkbox-${c.id}`);
    }
  });

  it("unchecking two classes and saving submits the remaining ids", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await openDialog();

    // Unchecking moves the dialog out of "all" mode into explicit subset
    // mode and removes that id from the selection.
    const cb1 = (await screen.findByTestId(
      "task-classes-checkbox-c1",
    )) as HTMLInputElement;
    const cb2 = (await screen.findByTestId(
      "task-classes-checkbox-c2",
    )) as HTMLInputElement;
    fireEvent.click(cb1);
    fireEvent.click(cb2);

    fireEvent.click(await screen.findByTestId("task-classes-save"));
    await waitFor(() => {
      expect(tasksApi.setClasses).toHaveBeenCalledTimes(1);
    });
    const [pid, tid, payload] = (
      tasksApi.setClasses as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(pid).toBe("p1");
    expect(tid).toBe("t1");
    expect(Array.isArray(payload)).toBe(true);
    // Only c3 stays selected.
    expect(payload).toEqual(["c3"]);
  });

  it("'Select all' clears the subset (submits null)", async () => {
    // Start with an explicit subset so "Select all" has work to do.
    (tasksApi.getClasses as ReturnType<typeof vi.fn>).mockResolvedValue({
      classes: [PROJECT_CLASSES[0]],
      allowed_class_ids: ["c1"],
    });
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await openDialog();

    fireEvent.click(await screen.findByTestId("task-classes-select-all"));
    fireEvent.click(await screen.findByTestId("task-classes-save"));

    await waitFor(() => {
      expect(tasksApi.setClasses).toHaveBeenCalledTimes(1);
    });
    const [, , payload] = (
      tasksApi.setClasses as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(payload).toBeNull();
  });

  it("'None' confirms then submits []", async () => {
    render(wrap(<ProjectDetailPage projectId="p1" />));
    await openDialog();

    fireEvent.click(await screen.findByTestId("task-classes-none"));
    // The shared ConfirmDialog primitive renders a confirm button
    // (data-testid: confirm-dialog-confirm).
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(confirmBtn);

    fireEvent.click(await screen.findByTestId("task-classes-save"));
    await waitFor(() => {
      expect(tasksApi.setClasses).toHaveBeenCalledTimes(1);
    });
    const [, , payload] = (
      tasksApi.setClasses as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(payload).toEqual([]);
  });
});

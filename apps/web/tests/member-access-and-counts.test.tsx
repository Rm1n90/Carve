/**
 * Member access per AI tool, as the editor shows it, and the annotation
 * counts report.
 *
 *  1. A member sees an AI tool only when its Member access setting allows
 *     it on this task (every task, or tasks opened for members).
 *  2. Admins see every tool; nothing shows while the settings load.
 *  3. The counts page totals each person and lists each task.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let role: "member" | "admin" = "member";
vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "u1", email: "u@example.com", role }, accessToken: "tok" }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/settings/annotation-counts" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));
vi.mock("@/api/client", () => ({ api: { get: vi.fn() } }));
vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([{ id: "p1", name: "Shelves" }]) },
}));
vi.mock("@/api/tasks", () => ({ tasksApi: { listForProject: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/api/reports", () => ({ reportsApi: { annotations: vi.fn() } }));

import { api } from "@/api/client";
import { reportsApi } from "@/api/reports";
import { useAiToolAccess } from "@/auth/aiAccess";
import { SettingsAnnotationCountsPage } from "@/pages/SettingsAnnotationCountsPage";

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  role = "member";
  get.mockResolvedValue({
    data: { sam: "all_tasks", my_model: "admins", yoloe: "opened_tasks", logo_ai: "admins" },
  });
});
afterEach(() => cleanup());

describe("useAiToolAccess", () => {
  it("follows each tool's setting and the task's switch", async () => {
    const closed = renderHook(() => useAiToolAccess({ gpu_access_for_members: false }), {
      wrapper,
    });
    await waitFor(() => expect(closed.result.current.sam).toBe(true));
    expect(closed.result.current).toEqual({
      sam: true,
      my_model: false,
      yoloe: false,
      logo_ai: false,
    });
    const opened = renderHook(() => useAiToolAccess({ gpu_access_for_members: true }), {
      wrapper,
    });
    await waitFor(() => expect(opened.result.current.yoloe).toBe(true));
    expect(opened.result.current.my_model).toBe(false);
    expect(get).toHaveBeenCalledWith("/workspace/ai-access");
  });

  it("gives admins everything without asking, and members nothing while loading", () => {
    get.mockReturnValue(new Promise(() => undefined));
    const member = renderHook(() => useAiToolAccess({ gpu_access_for_members: true }), {
      wrapper,
    });
    expect(Object.values(member.result.current)).toEqual([false, false, false, false]);
    role = "admin";
    vi.clearAllMocks();
    const admin = renderHook(() => useAiToolAccess(undefined), { wrapper });
    expect(Object.values(admin.result.current)).toEqual([true, true, true, true]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Annotation counts", () => {
  it("totals each person and lists each task", async () => {
    (reportsApi.annotations as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      group_by: "task",
      since: null,
      rows: [
        {
          project_id: "p1", project_name: "Shelves", task_id: "t1", task_name: "Set 1",
          class_name: null, user_id: "a", email: "alice@example.com",
          total: 1200, from_ai: 200, images: 300,
        },
        {
          project_id: "p1", project_name: "Shelves", task_id: "t2", task_name: "Set 2",
          class_name: null, user_id: "a", email: "alice@example.com",
          total: 800, from_ai: 0, images: 100,
        },
        {
          project_id: "p1", project_name: "Shelves", task_id: "t1", task_name: "Set 1",
          class_name: null, user_id: "b", email: "bob@example.com",
          total: 100, from_ai: 0, images: 40,
        },
      ],
    });
    render(<SettingsAnnotationCountsPage />, { wrapper });
    const people = await screen.findByTestId("counts-by-person");
    const alice = within(people).getByText("alice@example.com").closest("tr") as HTMLElement;
    expect(within(alice).getByText((2000).toLocaleString())).toBeInTheDocument();
    expect(within(alice).getByText((1800).toLocaleString())).toBeInTheDocument();
    const detail = screen.getByTestId("counts-detail");
    expect(within(detail).getAllByRole("row")).toHaveLength(4);
    expect(reportsApi.annotations).toHaveBeenCalledWith({ group_by: "task" });
  });
});

/**
 * v3.1 Issue 5 — LeftNav Annotate section: project→tasks tree, with
 * "All projects" pinned to the bottom of the section.
 *
 * Asserts:
 *   - "All projects" is the LAST nav item in Annotate (not first).
 *   - Clicking the chevron on a project expands it and renders its
 *     task list nested below (lazy fetch — only when expanded).
 *   - Task list caps at 5 with a "+ N more" overflow link to the
 *     project detail page.
 *   - Toggling the chevron again collapses the task list.
 *   - When a task route is the current path, that project's tasks list
 *     is auto-expanded on mount and the active task row is highlighted.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockPathname = "/projects";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => {
    let href = to ?? "#";
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, String(v));
      }
    }
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: mockPathname } }),
  useNavigate: () => () => undefined,
}));

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "user@example.com", role: "member" },
    }),
}));

vi.mock("@/auth/api", () => ({
  logout: vi.fn(),
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
  },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    listForProject: vi.fn(),
  },
}));

import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { LeftNav } from "@/components/nav/LeftNav";
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

const projects = [
  { id: "A", name: "Project Alpha", description: null, owner_id: "u1", created_at: "2026-04-26T10:00:00+00:00" },
  { id: "B", name: "Project Beta", description: null, owner_id: "u1", created_at: "2026-04-26T10:00:00+00:00" },
  { id: "C", name: "Project Gamma", description: null, owner_id: "u1", created_at: "2026-04-26T10:00:00+00:00" },
];

const tasksA = [
  { id: "TA1", project_id: "A", name: "Task A1", kind: "image" as const, created_at: "2026-04-26T10:00:00+00:00" },
  { id: "TA2", project_id: "A", name: "Task A2", kind: "image" as const, created_at: "2026-04-26T10:00:00+00:00" },
];

const tasksB = Array.from({ length: 7 }, (_, i) => ({
  id: `TB${i + 1}`,
  project_id: "B",
  name: `Task B${i + 1}`,
  kind: "image" as const,
  created_at: "2026-04-26T10:00:00+00:00",
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname = "/projects";
  (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(projects);
  (tasksApi.listForProject as ReturnType<typeof vi.fn>).mockImplementation(
    async (projectId: string) => {
      if (projectId === "A") return tasksA;
      if (projectId === "B") return tasksB;
      return [];
    },
  );
});

describe("LeftNav — project→tasks tree (v3.1 Issue 5)", () => {
  it("places 'All projects' as the LAST nav item in the Annotate section", async () => {
    render(wrap(<LeftNav />));

    // Wait for the project list to populate.
    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-A")).toBeInTheDocument();
    });

    const projectA = screen.getByTestId("leftnav-project-A");
    const projectC = screen.getByTestId("leftnav-project-C");
    const allProjects = screen.getByTestId("leftnav-all-projects");

    // Walk DOM order — collect both dynamic project rows and the static
    // "All projects" entry. We exclude the chevron button + project
    // link descendants whose data-testid attrs nest inside the row.
    const items = Array.from(
      document.querySelectorAll(
        '[data-testid="leftnav-project-A"], [data-testid="leftnav-project-B"], [data-testid="leftnav-project-C"], [data-testid="leftnav-all-projects"]',
      ),
    );

    expect(items).toContain(projectA);
    expect(items).toContain(projectC);
    expect(items).toContain(allProjects);
    // "All projects" must come AFTER all dynamic project rows.
    expect(items.indexOf(allProjects)).toBeGreaterThan(items.indexOf(projectA));
    expect(items.indexOf(allProjects)).toBeGreaterThan(items.indexOf(projectC));
    // And it should be the very last entry.
    expect(items[items.length - 1]).toBe(allProjects);
  });

  it("expanding project A reveals its 2 tasks nested below", async () => {
    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-A")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("leftnav-task-TA1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("leftnav-project-toggle-A"));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-task-TA1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("leftnav-task-TA2")).toBeInTheDocument();
    expect(screen.getByText("Task A1")).toBeInTheDocument();
    expect(screen.getByText("Task A2")).toBeInTheDocument();
    // No overflow for project A (only 2 tasks).
    expect(
      screen.queryByTestId("leftnav-tasks-more-A"),
    ).not.toBeInTheDocument();
  });

  it("expanding project B caps tasks at 5 and shows '+ 2 more' overflow", async () => {
    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-B")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("leftnav-project-toggle-B"));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-task-TB1")).toBeInTheDocument();
    });

    // First 5 tasks visible.
    for (let i = 1; i <= 5; i += 1) {
      expect(screen.getByTestId(`leftnav-task-TB${i}`)).toBeInTheDocument();
    }
    // Tasks 6 and 7 are NOT rendered as nav items.
    expect(screen.queryByTestId("leftnav-task-TB6")).not.toBeInTheDocument();
    expect(screen.queryByTestId("leftnav-task-TB7")).not.toBeInTheDocument();

    const more = screen.getByTestId("leftnav-tasks-more-B");
    expect(more).toBeInTheDocument();
    expect(more.textContent).toContain("+ 2 more");
  });

  it("clicking the chevron a second time collapses the task list", async () => {
    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-A")).toBeInTheDocument();
    });

    const toggle = screen.getByTestId("leftnav-project-toggle-A");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-task-TA1")).toBeInTheDocument();
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.queryByTestId("leftnav-task-TA1")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("leftnav-task-TA2")).not.toBeInTheDocument();
  });

  it("auto-expands the project that owns the active task route and highlights the active task", async () => {
    mockPathname = "/projects/A/tasks/TA1";

    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-A")).toBeInTheDocument();
    });

    // Project A's tasks should appear without a manual click.
    await waitFor(() => {
      expect(screen.getByTestId("leftnav-task-TA1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("leftnav-task-TA2")).toBeInTheDocument();

    // Active task row carries the accent background utility class as a
    // visual highlight. We inspect the inner span that owns the styling.
    const ta1Row = screen.getByTestId("leftnav-task-TA1");
    const styled = ta1Row.querySelector("span");
    expect(styled).not.toBeNull();
    expect(styled?.className).toContain("bg-[var(--accent-bg)]");
  });
});

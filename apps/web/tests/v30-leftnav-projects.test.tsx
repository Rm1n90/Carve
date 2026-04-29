/**
 * v3.0 C5 — LeftNav Annotate section now lists the user's projects.
 *
 * Asserts:
 *   - With <=8 projects: each project name renders as a NavItem.
 *   - With >8 projects: only the first 8 render + a "Show all (N)" link.
 *   - With 0 projects: only the existing "All projects" entry renders.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
    // Resolve TanStack-style params into a real href so jsdom + RTL can
    // assert on the rendered link target.
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
  }) => select({ location: { pathname: "/projects" } }),
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

import { projectsApi } from "@/api/projects";
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

function makeProjects(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Project ${i + 1}`,
    description: null,
    owner_id: "u1",
    created_at: "2026-04-26T10:00:00+00:00",
  }));
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeftNav — Annotate section project list (v3.0 C5)", () => {
  it("renders all projects when count <= 8", async () => {
    const projects = makeProjects(5);
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(projects);

    render(wrap(<LeftNav />));

    for (const p of projects) {
      await waitFor(() => {
        expect(screen.getByTestId(`leftnav-project-${p.id}`)).toBeInTheDocument();
      });
      expect(screen.getByText(p.name)).toBeInTheDocument();
    }
    expect(
      screen.queryByTestId("leftnav-projects-show-all"),
    ).not.toBeInTheDocument();
  });

  it("renders 8 projects + 'Show all (N)' link when count > 8", async () => {
    const projects = makeProjects(12);
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(projects);

    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-p1")).toBeInTheDocument();
    });

    for (let i = 1; i <= 8; i += 1) {
      expect(screen.getByTestId(`leftnav-project-p${i}`)).toBeInTheDocument();
    }
    for (let i = 9; i <= 12; i += 1) {
      expect(
        screen.queryByTestId(`leftnav-project-p${i}`),
      ).not.toBeInTheDocument();
    }

    const showAll = screen.getByTestId("leftnav-projects-show-all");
    expect(showAll).toBeInTheDocument();
    expect(showAll.textContent).toContain("Show all (12)");
  });

  it("with zero projects, only the static 'All projects' entry shows", async () => {
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(wrap(<LeftNav />));

    expect(await screen.findByText("All projects")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByTestId("leftnav-projects-loading"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("leftnav-projects-show-all"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-testid^="leftnav-project-"]'),
    ).toBeNull();
  });
});

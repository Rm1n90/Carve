/**
 * LeftNav Annotate section lists the user's projects.
 *
 * The rail lists EVERY project (no cap) inside a scroll container and ends
 * with a persistent "All projects" row, so it fills the panel instead of
 * truncating at 8 and leaving the lower half empty.
 *
 * Asserts:
 *   - Any project count: every project name renders as a NavItem.
 *   - The "All projects" row is always present; the old 8-cap
 *     "leftnav-projects-show-all" link is gone.
 *   - With 0 projects: only the "All projects" entry renders.
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

import { TooltipProvider } from "@radix-ui/react-tooltip";

import { projectsApi } from "@/api/projects";
import { LeftNav } from "@/components/nav/LeftNav";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>{node}</ConfirmProvider>
      </TooltipProvider>
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

describe("LeftNav — Annotate section project list", () => {
  it("renders every project (no cap) and a persistent 'All projects' row", async () => {
    const projects = makeProjects(5);
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(projects);

    render(wrap(<LeftNav />));

    for (const p of projects) {
      await waitFor(() => {
        expect(screen.getByTestId(`leftnav-project-${p.id}`)).toBeInTheDocument();
      });
      expect(screen.getByText(p.name)).toBeInTheDocument();
    }
    // Persistent footer row, and the retired 8-cap link is gone.
    expect(screen.getByTestId("leftnav-all-projects")).toBeInTheDocument();
    expect(
      screen.queryByTestId("leftnav-projects-show-all"),
    ).not.toBeInTheDocument();
  });

  it("renders ALL projects when count > 8 (the old 8-item cap is removed)", async () => {
    const projects = makeProjects(12);
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue(projects);

    render(wrap(<LeftNav />));

    await waitFor(() => {
      expect(screen.getByTestId("leftnav-project-p1")).toBeInTheDocument();
    });

    // Every one of the 12 projects renders — nothing is hidden behind a cap.
    for (let i = 1; i <= 12; i += 1) {
      expect(screen.getByTestId(`leftnav-project-p${i}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("leftnav-all-projects")).toBeInTheDocument();
    expect(
      screen.queryByTestId("leftnav-projects-show-all"),
    ).not.toBeInTheDocument();
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

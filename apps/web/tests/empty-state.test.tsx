import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Plan 14 Phase 8 Task 10 — <EmptyState> unit tests.
 *
 * Verifies the editorial empty-state component renders title /
 * description / CTA, that the compact variant marks itself accordingly,
 * and that the ProjectsPage empty-projects branch renders an empty
 * state when no projects exist.
 */

import { EmptyState } from "@/components/ui/EmptyState";

afterEach(() => {
  cleanup();
});

describe("<EmptyState>", () => {
  it("renders the title, description, and CTA", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Start your first project"
        description="Carve datasets and annotation workspaces."
        cta={{ label: "Create project", onClick }}
      />,
    );
    expect(screen.getByTestId("empty-state-title")).toHaveTextContent(
      "Start your first project",
    );
    expect(screen.getByTestId("empty-state-description")).toHaveTextContent(
      "Carve datasets and annotation workspaces.",
    );
    const cta = screen.getByTestId("empty-state-cta");
    expect(cta).toHaveTextContent("Create project");
    fireEvent.click(cta);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders an icon slot when provided", () => {
    render(
      <EmptyState
        title="No matches"
        icon={<svg data-testid="custom-icon" />}
      />,
    );
    expect(screen.getByTestId("empty-state-icon")).toBeInTheDocument();
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });

  it("renders the CTA as an anchor when an href is supplied", () => {
    render(
      <EmptyState
        title="No tasks yet"
        cta={{ label: "Open docs", href: "/docs/tasks" }}
      />,
    );
    const cta = screen.getByTestId("empty-state-cta") as HTMLAnchorElement;
    expect(cta.tagName).toBe("A");
    expect(cta.getAttribute("href")).toBe("/docs/tasks");
  });

  it("compact variant marks the wrapper and uses smaller padding classes", () => {
    render(<EmptyState variant="compact" title="No audit events" />);
    const root = screen.getByTestId("empty-state");
    expect(root.getAttribute("data-variant")).toBe("compact");
    // ``py-6`` is the compact vertical padding; ``py-14`` is the default.
    expect(root.className).toContain("py-6");
    expect(root.className).not.toContain("py-14");
  });

  it("default variant uses the larger whitespace footprint", () => {
    render(<EmptyState title="No projects yet" />);
    const root = screen.getByTestId("empty-state");
    expect(root.getAttribute("data-variant")).toBe("default");
    expect(root.className).toContain("py-14");
  });
});

// ---------------------------------------------------------------------------
// ProjectsPage integration — projects.length === 0 branch surfaces the
// new EmptyState card with the "Start your first project" copy.
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    [k: string]: unknown;
  }) => (
    <a href={to ?? "#"} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
  useNavigate: () => () => undefined,
  useRouterState: () => ({ location: { pathname: "/projects" } }),
}));
vi.mock("@/auth/store", () => ({
  useAuth: (
    selector: (s: { user: { id: string; email: string } | null }) => unknown,
  ) => selector({ user: { id: "u-1", email: "u@example.com" } }),
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
  },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectsPage } from "@/pages/ProjectsPage";

describe("ProjectsPage empty state", () => {
  it("renders the EmptyState when no projects exist", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ProjectsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("projects-empty")).toBeInTheDocument();
    expect(screen.getByTestId("empty-state-title")).toHaveTextContent(
      /first project/i,
    );
  });
});

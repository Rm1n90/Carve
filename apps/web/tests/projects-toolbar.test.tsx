import React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Plan 14 Phase 8 Task 1 — projects index toolbar tests.
 *
 * Covers:
 *   - Search narrows the visible rows (case-insensitive, by name + email).
 *   - Sort by name flips order; sort by created flips by created_at.
 *   - Pin star toggles state and persists via the prefs slice.
 *   - The "Pinned" filter chip restricts to pinned-only.
 */

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    "aria-label": aria,
    className,
  }: {
    children: React.ReactNode;
    params?: { projectId?: string };
    "aria-label"?: string;
    className?: string;
  }) => (
    <a
      href={params?.projectId ? `/projects/${params.projectId}` : "#"}
      aria-label={aria}
      className={className}
      data-testid="project-card-link"
    >
      {children}
    </a>
  ),
}));

import { projectsApi } from "@/api/projects";
import { ProjectsPage } from "@/pages/ProjectsPage";
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

const PROJECTS = [
  {
    id: "p1",
    name: "Alpha Cars",
    description: "Dataset A",
    owner_id: "u1",
    owner_email: "alice@example.com",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "p2",
    name: "Beta Ships",
    description: "Dataset B",
    owner_id: "u2",
    owner_email: "bob@example.com",
    created_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "p3",
    name: "Charlie Trains",
    description: null,
    owner_id: "u1",
    owner_email: "alice@example.com",
    created_at: "2026-03-01T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Reset persistent prefs so pin state from a prior test doesn't leak.
  useProjectPrefs.setState({
    pinnedProjectIds: [],
    recentProjectIds: [],
  });
  localStorage.clear();
  (projectsApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    PROJECTS,
  );
});

afterEach(() => {
  // Defensive: ensure no fake timers leak between tests.
  vi.useRealTimers();
});

describe("ProjectsToolbar", () => {
  it("narrows the list when typing in the search box (debounced)", async () => {
    render(wrap(<ProjectsPage />));

    await waitFor(() => {
      expect(screen.getByText("Alpha Cars")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Ships")).toBeInTheDocument();
    expect(screen.getByText("Charlie Trains")).toBeInTheDocument();

    const input = screen.getByTestId(
      "projects-toolbar-search",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });

    // Wait past the 200ms debounce using real timers — fake timers
    // also stop the React Query promise microtask flush in this setup.
    await waitFor(
      () => {
        expect(screen.queryByText("Beta Ships")).not.toBeInTheDocument();
      },
      { timeout: 1500 },
    );
    expect(screen.getByText("Alpha Cars")).toBeInTheDocument();
    expect(screen.queryByText("Charlie Trains")).not.toBeInTheDocument();
  });

  it("matches on owner email as well as name", async () => {
    render(wrap(<ProjectsPage />));

    await waitFor(() => {
      expect(screen.getByText("Alpha Cars")).toBeInTheDocument();
    });

    const input = screen.getByTestId(
      "projects-toolbar-search",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bob@" } });

    await waitFor(
      () => {
        expect(screen.queryByText("Alpha Cars")).not.toBeInTheDocument();
      },
      { timeout: 1500 },
    );
    expect(screen.getByText("Beta Ships")).toBeInTheDocument();
  });

  it("re-orders rows when the sort dropdown changes", async () => {
    render(wrap(<ProjectsPage />));

    await waitFor(() => {
      expect(screen.getByText("Alpha Cars")).toBeInTheDocument();
    });

    function visibleNames(): string[] {
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid^="projects-row-"] h3',
        ),
      ).map((el) => el.textContent ?? "");
    }

    // Default: name-asc.
    expect(visibleNames()).toEqual([
      "Alpha Cars",
      "Beta Ships",
      "Charlie Trains",
    ]);

    fireEvent.change(screen.getByTestId("projects-toolbar-sort"), {
      target: { value: "name-desc" },
    });
    await waitFor(() => {
      expect(visibleNames()[0]).toBe("Charlie Trains");
    });
    expect(visibleNames()).toEqual([
      "Charlie Trains",
      "Beta Ships",
      "Alpha Cars",
    ]);

    fireEvent.change(screen.getByTestId("projects-toolbar-sort"), {
      target: { value: "created-desc" },
    });
    await waitFor(() => {
      // Charlie has the newest created_at.
      expect(visibleNames()[0]).toBe("Charlie Trains");
    });
    expect(visibleNames()[2]).toBe("Alpha Cars");
  });

  it("toggles the pin star and persists via the prefs slice", async () => {
    render(wrap(<ProjectsPage />));

    await waitFor(() => {
      expect(screen.getByText("Beta Ships")).toBeInTheDocument();
    });

    const star = screen.getByTestId("projects-pin-toggle-p2");
    expect(useProjectPrefs.getState().pinnedProjectIds).toEqual([]);

    fireEvent.click(star);

    await waitFor(() => {
      expect(useProjectPrefs.getState().pinnedProjectIds).toContain("p2");
    });

    // Star reflects the pinned state.
    const starAfter = screen.getByTestId("projects-pin-toggle-p2");
    expect(starAfter.getAttribute("aria-pressed")).toBe("true");

    // Toggling again unpins.
    fireEvent.click(starAfter);
    await waitFor(() => {
      expect(useProjectPrefs.getState().pinnedProjectIds).not.toContain("p2");
    });
  });

  it("the Pinned filter chip shows only pinned projects", async () => {
    // Seed pinned state up front.
    useProjectPrefs.setState({
      pinnedProjectIds: ["p2"],
      recentProjectIds: [],
    });

    render(wrap(<ProjectsPage />));

    await waitFor(() => {
      expect(screen.getByText("Alpha Cars")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("projects-toolbar-filter-pinned"));

    await waitFor(() => {
      expect(screen.queryByText("Alpha Cars")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Beta Ships")).toBeInTheDocument();
    expect(screen.queryByText("Charlie Trains")).not.toBeInTheDocument();
  });
});

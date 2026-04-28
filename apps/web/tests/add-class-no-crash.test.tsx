/**
 * Reproduction for v2.7 user-reported bug: "When I click add class the UI breaks".
 *
 * This file targets the project-detail page (`ProjectDetailPage` ->
 * `ClassesEditor`) where the add-class form lives at the bottom of the
 * right-hand classes column. We render the page, fill in a name and color,
 * click "Add class", and verify:
 *  - the API mutation fires with the expected shape
 *  - the form re-arms cleanly (name input cleared) for the next add
 *  - nothing in the parent tree throws
 *
 * Also covers the rapid-double-click case that v2.6's loosened rate limits
 * exposed: clicking the submit button while a mutation is already in flight
 * must not crash the app.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/stats", () => ({
  statsApi: {
    projectStats: vi.fn().mockResolvedValue({
      totals: { annotations: 0, assets: 0, tasks: 0 },
      by_class: [],
      tasks: [],
    }),
  },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: { get: vi.fn(), update: vi.fn() },
}));
vi.mock("@/api/tasks", () => ({
  tasksApi: { listForProject: vi.fn(), create: vi.fn() },
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
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { classesApi } from "@/api/classes";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function seedDefaults() {
  (projectsApi.get as any).mockResolvedValue({
    id: "p-1",
    name: "Demo",
    description: null,
    owner_id: "u",
    created_at: "2026-01-01",
  });
  (tasksApi.listForProject as any).mockResolvedValue([]);
  (classesApi.listForProject as any).mockResolvedValue([]);
}

describe("ProjectDetailPage — Add class flow does not crash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedDefaults();
  });

  it("renders the classes editor without throwing on mount", async () => {
    render(wrap(<ProjectDetailPage projectId="p-1" />));
    await screen.findByText(/Demo/);
    await waitFor(() => {
      expect(screen.getByTestId("classes-editor-footer")).toBeInTheDocument();
    });
  });

  it("submitting the add-class form calls the API and resets the name input", async () => {
    (classesApi.create as any).mockResolvedValue({
      id: "c-1",
      project_id: "p-1",
      idx: 0,
      name: "test",
      color: "#EF4444",
      attributes: {},
      created_at: "2026-04-26",
    });
    render(wrap(<ProjectDetailPage projectId="p-1" />));
    await screen.findByTestId("classes-editor-footer");

    fireEvent.change(screen.getByLabelText(/class name/i), {
      target: { value: "test" },
    });
    fireEvent.change(screen.getByLabelText(/^color$/i), {
      target: { value: "#EF4444" },
    });

    fireEvent.click(screen.getByRole("button", { name: /add class/i }));

    await waitFor(() => {
      // jsdom normalizes <input type="color"> values to lowercase, so we
      // assert on the lowercased hex.
      expect(classesApi.create).toHaveBeenCalledWith("p-1", {
        idx: 0,
        name: "test",
        color: "#ef4444",
      });
    });
    await waitFor(() => {
      const after = screen.getByLabelText(/class name/i) as HTMLInputElement;
      expect(after.value).toBe("");
    });
  });

  it("does NOT crash when the user double-clicks Add class while the mutation is in flight", async () => {
    let resolveCreate: ((v: unknown) => void) | null = null;
    (classesApi.create as any).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    render(wrap(<ProjectDetailPage projectId="p-1" />));
    await screen.findByTestId("classes-editor-footer");

    fireEvent.change(screen.getByLabelText(/class name/i), {
      target: { value: "person" },
    });
    const submit = screen.getByRole("button", { name: /add class/i });
    // Rapid clicks: v2.6 relaxed rate limits + retry-on-429 mean a user
    // can fire several mutations in quick succession before the form clears.
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.click(submit);

    // Button flips to the loading "Adding" state, parent does not unmount.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /adding/i })).toBeInTheDocument();
    });
    expect(screen.getByTestId("classes-editor-footer")).toBeInTheDocument();

    const fn = resolveCreate as ((v: unknown) => void) | null;
    fn?.({
      id: "c-2",
      project_id: "p-1",
      idx: 0,
      name: "person",
      color: "#EF4444",
      attributes: {},
      created_at: "2026-04-26",
    });
  });

  it("does NOT crash when the API call rejects (e.g. 429 rate limit)", async () => {
    (classesApi.create as any).mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        response: { status: 429 },
      }),
    );

    render(wrap(<ProjectDetailPage projectId="p-1" />));
    await screen.findByTestId("classes-editor-footer");

    fireEvent.change(screen.getByLabelText(/class name/i), {
      target: { value: "tree" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add class/i }));

    await waitFor(() => {
      expect(classesApi.create).toHaveBeenCalledTimes(1);
    });
    // The editor must still be mounted and usable after a rejected mutation.
    expect(screen.getByTestId("classes-editor-footer")).toBeInTheDocument();
    expect(screen.getByLabelText(/class name/i)).toBeInTheDocument();
  });
});

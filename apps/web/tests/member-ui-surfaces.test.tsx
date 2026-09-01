import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

/**
 * Outsourcing hardening — screen-level coverage for the member view.
 *
 * The first pass at this feature gated the dialogs where they were
 * *defined* and the task-row actions on the project page, but missed the
 * task detail page's own Upload / Import / Export toolbar — which lives
 * in `routes/`, not `pages/`. A member opening a task still saw an
 * Export button (it 403'd on click, so nothing leaked, but the control
 * should never have rendered).
 *
 * These tests assert on the rendered screen rather than on a component
 * in isolation, so a restricted control added to any *new* mount point
 * is caught here.
 */

vi.mock("@/api/projects", () => ({
  projectsApi: {
    get: vi.fn().mockResolvedValue({
      id: "p1", name: "Proj", description: null,
      owner_id: "u1", created_at: "2026-01-01",
    }),
    list: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn().mockResolvedValue({
      id: "t1", project_id: "p1", name: "Task", kind: "image",
      created_at: "2026-01-01", gpu_access_for_members: false,
    }),
    listForProject: vi.fn().mockResolvedValue([]),
    getClasses: vi.fn().mockResolvedValue({ classes: [], allowed_class_ids: null }),
  },
}));
vi.mock("@/pages/AssetGrid", () => ({ AssetGrid: () => <div>assets</div> }));
vi.mock("@/pages/StatsPanel", () => ({ StatsPanel: () => <div>stats</div> }));
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useParams: () => ({ projectId: "p1", taskId: "t1" }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
    createRoute: () => ({}),
    useNavigate: () => vi.fn(),
  };
});

import { useAuth, type Role } from "@/auth/store";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

function signInAs(role: Role): void {
  useAuth.getState().setSession({
    accessToken: "t",
    refreshToken: "r",
    user: { id: `u-${role}`, email: `${role}@t.local`, role },
  });
}

/** Controls that must never render for a restricted member. */
const FORBIDDEN_TESTIDS = [
  "task-action-upload",
  "task-action-import",
  "task-action-export",
];

async function renderTaskPage() {
  const { TaskDetail } = await import(
    "@/routes/projects.$projectId.tasks.$taskId"
  );
  render(wrap(<TaskDetail />));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  useAuth.getState().clear();
});

describe("task detail page — data-movement toolbar", () => {
  it("hides Upload, Import and Export from a member", async () => {
    signInAs("member");
    await renderTaskPage();
    await waitFor(() => expect(screen.getByText("assets")).toBeInTheDocument());
    for (const id of FORBIDDEN_TESTIDS) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    // The word "Export" must not appear anywhere on the member's screen.
    expect(screen.queryByText(/^Export$/)).toBeNull();
  });

  it("still shows all three to an admin", async () => {
    signInAs("admin");
    await renderTaskPage();
    await waitFor(() =>
      expect(screen.getByTestId("task-action-export")).toBeInTheDocument(),
    );
    for (const id of FORBIDDEN_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeNull();
    }
  });

  it("treats viewer like member", async () => {
    signInAs("viewer");
    await renderTaskPage();
    await waitFor(() => expect(screen.getByText("assets")).toBeInTheDocument());
    expect(screen.queryByTestId("task-action-export")).toBeNull();
  });
});

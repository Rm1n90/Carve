/**
 * v3.0 Bug 8 — ClassesEditor "Copy from project…" flow.
 *
 * Asserts the trigger button opens a Dialog, lists candidate projects
 * (excluding the current project), and on confirm fires
 * `projectsApi.importClasses(currentProjectId, sourceProjectId)`.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
    importClasses: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { ClassesEditor } from "@/pages/ClassesEditor";
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

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

describe("ClassesEditor — Copy from project (v3.0 Bug 8)", () => {
  it("opens the picker, lists OTHER projects, and calls importClasses on confirm", async () => {
    (classesApi.listForProject as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (projectsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "p1",
        name: "Current Project",
        description: null,
        owner_id: "u1",
        created_at: "2026-04-29T00:00:00+00:00",
      },
      {
        id: "p2",
        name: "Source Project",
        description: null,
        owner_id: "u1",
        created_at: "2026-04-28T00:00:00+00:00",
      },
    ]);
    (projectsApi.importClasses as ReturnType<typeof vi.fn>).mockResolvedValue({
      imported: 4,
      skipped: 1,
    });

    render(wrap(<ClassesEditor projectId="p1" />));

    // Open the picker.
    const trigger = await screen.findByTestId(
      "classes-editor-copy-from-project",
    );
    fireEvent.click(trigger);

    // Source project listed; current project excluded.
    const sourceBtn = await screen.findByTestId("copy-classes-source-p2");
    expect(sourceBtn).toBeInTheDocument();
    expect(screen.queryByTestId("copy-classes-source-p1")).not.toBeInTheDocument();

    // Pick + confirm.
    fireEvent.click(sourceBtn);
    fireEvent.click(screen.getByTestId("copy-classes-confirm"));

    await waitFor(() => {
      expect(projectsApi.importClasses).toHaveBeenCalledWith("p1", "p2");
    });
  });
});

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { projectsApi } from "@/api/projects";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

describe("ProjectsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists projects from the API", async () => {
    (projectsApi.list as any).mockResolvedValue([
      { id: "p1", name: "Alpha", description: null, owner_id: "u", created_at: "2026-01-01" },
      { id: "p2", name: "Beta", description: "x", owner_id: "u", created_at: "2026-01-02" },
    ]);
    render(wrap(<ProjectsPage />));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("creates a project via the form", async () => {
    (projectsApi.list as any).mockResolvedValue([]);
    (projectsApi.create as any).mockResolvedValue({
      id: "n",
      name: "New",
      description: null,
      owner_id: "u",
      created_at: "2026-01-01",
    });
    render(wrap(<ProjectsPage />));
    fireEvent.click(await screen.findByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => {
      expect(projectsApi.create).toHaveBeenCalledWith({ name: "New", description: undefined });
    });
  });
});

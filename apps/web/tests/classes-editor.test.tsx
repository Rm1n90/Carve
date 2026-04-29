import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { ClassesEditor } from "@/pages/ClassesEditor";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

describe("ClassesEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a class with idx + color", async () => {
    (classesApi.listForProject as any).mockResolvedValue([]);
    (classesApi.create as any).mockResolvedValue({
      id: "c1",
      project_id: "p1",
      idx: 0,
      name: "car",
      color: "#ff0000",
      attributes: {},
      created_at: "2026-01-01",
    });
    render(wrap(<ClassesEditor projectId="p1" />));
    fireEvent.change(await screen.findByLabelText(/class name/i), {
      target: { value: "car" },
    });
    fireEvent.change(screen.getByLabelText(/^color$/i), {
      target: { value: "#ff0000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add class/i }));
    await waitFor(() => {
      expect(classesApi.create).toHaveBeenCalledWith("p1", {
        idx: 0,
        name: "car",
        color: "#ff0000",
      });
    });
  });
});

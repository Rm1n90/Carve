/**
 * v3.0 C6 — YOLO weights page (`/models/yolo`) layout + details panel.
 *
 * Asserts:
 *   - Layout grid uses `lg:grid-cols-[1fr_320px]` for the wide viewport
 *     two-column layout (table + side panel).
 *   - With no selection, the empty-state helper "Select a weight to see
 *     details" is visible.
 *   - Clicking a weight row populates the details panel with that
 *     row's filename.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/models/yolo" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "admin@example.com", role: "admin" },
    }),
}));

vi.mock("@/auth/api", () => ({
  logout: vi.fn(),
}));

vi.mock("@/api/phase2", () => ({
  weightsApi: {
    listWorkspace: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
  modelsApi: {
    samActive: vi.fn(),
  },
  trashApi: {
    list: vi.fn(),
    restore: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

import { weightsApi } from "@/api/phase2";
import { ModelsYoloPage } from "@/pages/Phase2Pages";
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

const MOCK_WEIGHTS = [
  {
    id: "w1",
    project_id: "p1",
    name: "yolov8n custom",
    task_kind: "detect" as const,
    minio_key: "weights/x.pt",
    size_bytes: 6_500_000,
    class_names: ["car", "truck"],
    created_by: null,
    created_at: "2026-04-26T10:00:00+00:00",
  },
  {
    id: "w2",
    project_id: "p1",
    name: "yolov8s segment",
    task_kind: "segment" as const,
    minio_key: "weights/y.pt",
    size_bytes: 22_000_000,
    class_names: ["person"],
    created_by: null,
    created_at: "2026-04-25T10:00:00+00:00",
  },
  {
    id: "w3",
    project_id: "p1",
    name: "yolov8m pose",
    task_kind: "pose" as const,
    minio_key: "weights/z.pt",
    size_bytes: 50_000_000,
    class_names: [],
    created_by: null,
    created_at: "2026-04-24T10:00:00+00:00",
  },
];

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue(
    MOCK_WEIGHTS,
  );
});

describe("ModelsYoloPage — full-width layout + details panel (v3.0 C6)", () => {
  it("uses the lg:grid-cols-[1fr_320px] layout grid", async () => {
    render(wrap(<ModelsYoloPage />));

    const grid = await screen.findByTestId("yolo-page-grid");
    expect(grid.className).toContain("lg:grid-cols-[1fr_320px]");
  });

  it("shows the empty-selection helper when no row is selected", async () => {
    render(wrap(<ModelsYoloPage />));

    // Wait for rows to render so we know the page settled.
    await screen.findByText("yolov8n custom");

    expect(screen.getByTestId("yolo-details-empty")).toHaveTextContent(
      /select a weight to see details/i,
    );
  });

  it("populates the details panel when a row is clicked", async () => {
    render(wrap(<ModelsYoloPage />));

    const row = await screen.findByTestId("weight-row-w2");
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByTestId("yolo-details-name")).toHaveTextContent(
        "yolov8s segment",
      );
    });
    // Empty-state helper is gone.
    expect(screen.queryByTestId("yolo-details-empty")).not.toBeInTheDocument();
    // Class chips show class names.
    expect(screen.getByTestId("yolo-details-classes")).toHaveTextContent(
      "person",
    );
  });
});

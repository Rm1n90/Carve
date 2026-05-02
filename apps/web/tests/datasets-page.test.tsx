import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/api/datasets", () => ({
  datasetsApi: {
    list: vi.fn(),
    get: vi.fn(),
    diff: vi.fn(),
    rollback: vi.fn(),
  },
}));

vi.mock("@/api/members", () => ({
  membersApi: {
    list: vi.fn(),
  },
}));

vi.mock("@/auth/store", () => ({
  useAuth: (
    selector: (s: { user: { id: string; email: string; role: string } }) => unknown,
  ) =>
    selector({
      user: { id: "user-1", email: "u@x.com", role: "admin" },
    }),
}));

vi.mock("@/lib/toast", () => ({
  showToast: vi.fn(),
}));

vi.mock("@/lib/relativeTime", () => ({
  formatRelative: (s: string) => `relative(${s})`,
}));

// Auto-confirm any confirm() prompt to keep the test deterministic.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  useConfirm: () => async () => true,
}));

import { datasetsApi } from "@/api/datasets";
import { membersApi } from "@/api/members";
import { DatasetsPage } from "@/pages/DatasetsPage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "p-1";

function makeRow(i: number, kind = "manual") {
  return {
    id: `v-${i}`,
    project_id: PROJECT_ID,
    task_id: `t-${i}`,
    kind,
    source: null,
    created_by: "user-1",
    created_at: "2026-04-30T10:00:00+00:00",
    label: `Version ${i}`,
    frozen: true,
    summary: { annotations: 100 + i, accepted: 90 + i, rejected: i },
    blob_key: null,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetsPage projectId={PROJECT_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (membersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "user-1", email: "u@x.com", role: "admin" },
  ]);
  (datasetsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [makeRow(1, "retrain"), makeRow(2, "export"), makeRow(3, "manual")],
    next_cursor: null,
  });
  (datasetsApi.diff as ReturnType<typeof vi.fn>).mockResolvedValue({
    a_id: "v-1",
    b_id: "v-2",
    added: { car: 5 },
    removed: { car: 1 },
    changed: { car: 2 },
    by_image: [
      { image: "a.png", added: 1, removed: 0, changed: 1 },
      { image: "b.png", added: 2, removed: 1, changed: 0 },
    ],
    summary_a: { annotations: 101 },
    summary_b: { annotations: 102 },
    note: null,
  });
  (datasetsApi.rollback as ReturnType<typeof vi.fn>).mockResolvedValue({
    pre_version_id: "pre-1",
    post_version_id: "post-1",
    replaced_count: 50,
    restored_count: 60,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetsPage", () => {
  it("renders the three mocked versions", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("datasets-row-v-1")).toBeInTheDocument();
      expect(screen.getByTestId("datasets-row-v-2")).toBeInTheDocument();
      expect(screen.getByTestId("datasets-row-v-3")).toBeInTheDocument();
    });
  });

  it("opens the compare modal after selecting two rows", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("datasets-row-v-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("datasets-row-v-1"));
    fireEvent.click(screen.getByTestId("datasets-row-v-2"), {
      metaKey: true,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("datasets-compare-button"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("dataset-compare-dialog")).not.toBeNull(),
    );
    await waitFor(() => expect(datasetsApi.diff).toHaveBeenCalledTimes(1));
    expect(datasetsApi.diff).toHaveBeenCalledWith(PROJECT_ID, "v-1", "v-2");
  });

  it("fires rollback after confirm for admin user", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("datasets-row-v-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("datasets-rollback-v-1"));

    await waitFor(() =>
      expect(datasetsApi.rollback).toHaveBeenCalledWith(
        PROJECT_ID,
        "v-1",
        "t-1",
      ),
    );
  });
});

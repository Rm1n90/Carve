/**
 * Plan-13 Phase 7 Task 9 — saved views menu tests.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/views", () => ({
  viewsApi: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    remove: vi.fn(),
  },
}));

import { viewsApi } from "@/api/views";
import { SavedViewsMenu } from "@/components/search/SavedViewsMenu";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const view1 = {
  id: "v1",
  task_id: "t1",
  owner: "u1",
  name: "My proposed",
  query: { status: "proposed" as const },
  shared: false,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};
const view2 = {
  id: "v2",
  task_id: "t1",
  owner: "u2",
  name: "Team review",
  query: { status: "accepted" as const },
  shared: true,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
};

describe("SavedViewsMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (viewsApi.list as any).mockResolvedValue([view1, view2]);
  });

  it("lists views and applies one when selected", async () => {
    const onSelect = vi.fn();
    const { findByTestId } = render(
      wrap(
        <SavedViewsMenu
          taskId="t1"
          currentQuery={{}}
          activeViewId={null}
          onSelect={onSelect}
        />,
      ),
    );

    const trigger = await findByTestId("saved-views-trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    const item = await findByTestId("saved-view-item-v1");
    fireEvent.click(item);

    expect(onSelect).toHaveBeenCalledWith(view1);
  });

  it("opens save dialog and POSTs with name + query", async () => {
    (viewsApi.create as any).mockResolvedValue({
      ...view1,
      id: "v-new",
      name: "Recent rejects",
    });
    const { findByTestId } = render(
      wrap(
        <SavedViewsMenu
          taskId="t1"
          currentQuery={{ status: "rejected" }}
          activeViewId={null}
          onSelect={vi.fn()}
        />,
      ),
    );

    const trigger = await findByTestId("saved-views-trigger");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    fireEvent.click(await findByTestId("saved-views-save-current"));

    const nameInput = (await findByTestId(
      "saved-views-name-input",
    )) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Recent rejects" } });

    const submit = await findByTestId("saved-views-save-submit");
    fireEvent.click(submit);

    await waitFor(() => {
      expect(viewsApi.create).toHaveBeenCalledWith("t1", {
        name: "Recent rejects",
        query: { status: "rejected" },
        shared: false,
      });
    });
  });
});

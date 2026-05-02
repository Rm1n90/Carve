/**
 * Plan-13 Phase 7 Task 9 — global Cmd-K search palette tests.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/api/search", () => ({
  searchApi: {
    assets: vi.fn(),
  },
}));

import { searchApi } from "@/api/search";
import { GlobalSearchBar } from "@/components/search/GlobalSearchBar";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("GlobalSearchBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (searchApi.assets as any).mockResolvedValue({
      items: [
        {
          asset_id: "a1",
          project_id: "p1",
          project_name: "Cars",
          task_id: "t1",
          task_name: "Frames",
          original_name: "foo.png",
          kind: "image",
          thumbnail_url: null,
          match_snippet: null,
        },
      ],
      next_cursor: null,
    });
  });

  it("opens on Cmd-K and debounces search calls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { findByTestId, queryByTestId } = render(wrap(<GlobalSearchBar />));

    expect(queryByTestId("global-search-dialog")).toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      );
    });

    const input = (await findByTestId("global-search-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });

    // Debounce window — fetch should not have fired yet.
    expect(searchApi.assets).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(220);
    });

    await waitFor(() => {
      expect(searchApi.assets).toHaveBeenCalledTimes(1);
    });
    expect((searchApi.assets as any).mock.calls[0][0]).toMatchObject({
      q: "foo",
      workspace: true,
      limit: 20,
    });

    vi.useRealTimers();
  });

  it("navigates to the asset path when a result is clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { findByTestId } = render(wrap(<GlobalSearchBar />));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      );
    });
    const input = (await findByTestId("global-search-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "foo" } });

    act(() => {
      vi.advanceTimersByTime(220);
    });

    const row = await findByTestId("global-search-result-a1");
    fireEvent.click(row);

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/projects/p1/tasks/t1/assets/a1",
      });
    });

    vi.useRealTimers();
  });
});

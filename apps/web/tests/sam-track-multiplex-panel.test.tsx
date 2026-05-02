/**
 * Plan 11 Task 5 — multiplex SamTrackPanel affordances.
 *
 *  - Text seed (Enter or Add) calls addObject({text}) and pushes one
 *    row per returned obj_id.
 *  - Per-row X removes from track (optimistic, reverts on 422).
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

vi.mock("@/api/sam_track", () => ({
  samTrackApi: {
    start: vi.fn(),
    addObject: vi.fn(),
    removeObject: vi.fn(),
    resetSession: vi.fn(),
    step: vi.fn(),
    release: vi.fn(),
  },
}));

import { samTrackApi } from "@/api/sam_track";
import { SamTrackPanel } from "@/components/annotation/SamTrackPanel";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { useSamTrackBridge } from "@/state/samTrackBridge";
import { subscribeToasts, type ToastEvent } from "@/lib/toast";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

const CLASSES = [
  { id: "c-A", name: "Person", color: "#ff0000", projectId: "p-1" },
  { id: "c-B", name: "Car", color: "#00ff00", projectId: "p-1" },
] as unknown as import("@/api/classes").ClassRow[];

beforeEach(() => {
  vi.clearAllMocks();
  useAnnotations.getState().reset([]);
  useTool.setState({
    active: "cursor",
    samMode: "point",
    activeClassId: "c-A",
  });
  useSamTrackBridge.getState().clear();
});

afterEach(() => {
  cleanup();
});

function renderPanel() {
  return render(
    wrap(
      <SamTrackPanel
        assetId="asset-vid-1"
        frameId="frame-id-0"
        currentFrameIdx={0}
        totalFrames={50}
        classes={CLASSES}
      />,
    ),
  );
}

describe("SamTrackPanel — multiplex text seed", () => {
  it("text Enter pushes one row per returned obj_id, all sharing the active class", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-mux",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_ids: [1, 2, 3],
      frame_idx: 0,
    });

    renderPanel();
    const input = screen.getByTestId("sam-track-text-input");
    fireEvent.change(input, { target: { value: "person" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(samTrackApi.addObject).toHaveBeenCalledWith(
        "asset-vid-1",
        "S-mux",
        expect.objectContaining({ frame_idx: 0, text: "person" }),
      );
    });

    // Three rows appear, each with the active class label "Person".
    await waitFor(() => {
      expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument();
      expect(screen.getByTestId("sam-track-object-2")).toBeInTheDocument();
      expect(screen.getByTestId("sam-track-object-3")).toBeInTheDocument();
    });
    expect(screen.getByTestId("sam-track-object-count")).toHaveTextContent("3");
    for (const id of [1, 2, 3]) {
      expect(screen.getByTestId(`sam-track-object-${id}`)).toHaveTextContent(
        "Person",
      );
    }
  });
});

describe("SamTrackPanel — per-row remove (multiplex)", () => {
  async function seedThree() {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-mux",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_ids: [1, 2, 3],
      frame_idx: 0,
    });
    renderPanel();
    const input = screen.getByTestId("sam-track-text-input");
    fireEvent.change(input, { target: { value: "person" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("sam-track-object-2")).toBeInTheDocument();
    });
  }

  it("clicking X on row 2 removes the row optimistically and calls removeObject", async () => {
    await seedThree();
    (samTrackApi.removeObject as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    fireEvent.click(screen.getByTestId("sam-track-remove-2"));

    await waitFor(() => {
      expect(samTrackApi.removeObject).toHaveBeenCalledWith(
        "asset-vid-1",
        "S-mux",
        2,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sam-track-object-2")).not.toBeInTheDocument();
    });
    // Other rows still present.
    expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument();
    expect(screen.getByTestId("sam-track-object-3")).toBeInTheDocument();
  });

  it("422 tracker_not_multiplex restores the row and shows a warning toast", async () => {
    await seedThree();
    const err422 = Object.assign(new Error("Request failed"), {
      response: {
        status: 422,
        data: { error: "tracker_not_multiplex" },
      },
    });
    (samTrackApi.removeObject as ReturnType<typeof vi.fn>).mockRejectedValue(
      err422,
    );
    const captured: ToastEvent[] = [];
    const unsub = subscribeToasts((evt) => captured.push(evt));

    try {
      fireEvent.click(screen.getByTestId("sam-track-remove-2"));

      // Row should reappear after the rejection.
      await waitFor(() => {
        expect(screen.getByTestId("sam-track-object-2")).toBeInTheDocument();
      });
      // A warning toast must fire.
      await waitFor(() => {
        const warn = captured.find(
          (t) =>
            t.variant === "warning" &&
            t.message === "Remove requires SAM 3.1 multiplex backend.",
        );
        expect(warn).toBeDefined();
      });
    } finally {
      unsub();
    }
  });
});

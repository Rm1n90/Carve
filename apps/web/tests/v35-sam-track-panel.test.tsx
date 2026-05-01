/**
 * v3.5 Phase E — SAM video tracking UI tests.
 *
 * Two layers:
 *   1. SamModePicker — Track chip is enabled on video assets and
 *      disabled (with the "Open a video asset…" tooltip) on images.
 *   2. SamTrackPanel — Start / Add object / Propagate / Commit flow
 *      hits the right samTrackApi methods and produces draft
 *      annotations through TrackPropagateTool.
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
  act,
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
    step: vi.fn(),
    release: vi.fn(),
  },
}));

// EditorToolbar pulls the SAM picker (samActive) and the YOLO predict
// popover. Mock both so the toolbar renders without network calls.
vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi.fn(),
  },
  weightsApi: {
    listForProject: vi.fn().mockResolvedValue([]),
    listWorkspace: vi.fn().mockResolvedValue([]),
  },
  inferenceApi: {
    predictYolo: vi.fn().mockResolvedValue({ count: 0 }),
  },
}));

import { samTrackApi } from "@/api/sam_track";
import { modelsApi } from "@/api/phase2";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { SamTrackPanel } from "@/components/annotation/SamTrackPanel";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { useSamTrackBridge } from "@/state/samTrackBridge";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAnnotations.getState().reset([]);
  useTool.setState({
    active: "cursor",
    samMode: "point",
    activeClassId: null,
  });
  useSamTrackBridge.getState().clear();
});

afterEach(() => {
  cleanup();
});

// --- SamModePicker — Track chip gating ------------------------------------

describe("SamModePicker — Track chip", () => {
  function renderToolbar(props: { isVideo?: boolean } = {}) {
    return render(
      wrap(
        <EditorToolbar
          onSave={vi.fn()}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          isVideo={props.isVideo}
        />,
      ),
    );
  }

  it("disables Track chip on an image asset (isVideo=false)", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam2.1-base+",
      available: ["sam2.1-base+"],
      reachable: true,
    });
    useTool.setState({ active: "sam" });
    renderToolbar({ isVideo: false });
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    const track = screen.getByTestId("sam-mode-track");
    expect(track).toBeDisabled();
    expect(track.getAttribute("data-disabled")).toBe("true");
  });

  it("enables Track chip on a video asset (isVideo=true) for SAM 2", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam2.1-large",
      available: ["sam2.1-large"],
      reachable: true,
    });
    useTool.setState({ active: "sam" });
    renderToolbar({ isVideo: true });
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    const track = screen.getByTestId("sam-mode-track");
    expect(track).not.toBeDisabled();
  });

  it("enables Track chip on a video asset for SAM 3 too", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam3",
      available: ["sam3"],
      reachable: true,
    });
    useTool.setState({ active: "sam" });
    renderToolbar({ isVideo: true });
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    const track = screen.getByTestId("sam-mode-track");
    expect(track).not.toBeDisabled();
  });

  it("clicking Track writes 'track' into the tool store", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam3",
      available: ["sam3"],
      reachable: true,
    });
    useTool.setState({ active: "sam", samMode: "point" });
    renderToolbar({ isVideo: true });
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-track")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("sam-mode-track"));
    expect(useTool.getState().samMode).toBe("track");
  });
});

// --- SamTrackPanel — Start / Add / Propagate / Commit ---------------------

describe("SamTrackPanel", () => {
  function renderPanel(
    props: Partial<React.ComponentProps<typeof SamTrackPanel>> = {},
  ) {
    return render(
      wrap(
        <SamTrackPanel
          assetId={props.assetId ?? "asset-vid-1"}
          frameId={props.frameId ?? "frame-id-0"}
          currentFrameIdx={props.currentFrameIdx ?? 0}
          totalFrames={props.totalFrames ?? 100}
          frameIdxToFrameId={props.frameIdxToFrameId}
        />,
      ),
    );
  }

  it("renders the frame indicator and a start button", () => {
    renderPanel();
    expect(screen.getByTestId("sam-track-panel")).toBeInTheDocument();
    expect(screen.getByTestId("sam-track-frame-indicator")).toHaveTextContent(
      "Frame 1 / 100",
    );
    expect(screen.getByTestId("sam-track-start")).toBeInTheDocument();
  });

  it("Start triggers samTrackApi.start with the current frame idx", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    renderPanel({ currentFrameIdx: 12 });
    fireEvent.click(screen.getByTestId("sam-track-start"));
    await waitFor(() => {
      expect(samTrackApi.start).toHaveBeenCalledWith("asset-vid-1", 12, [], []);
    });
  });

  it("Add object calls samTrackApi.addObject after a session is open", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_id: 1,
      frame_idx: 0,
    });
    useTool.setState({ activeClassId: "c-A" });
    renderPanel();
    fireEvent.click(screen.getByTestId("sam-track-start"));
    await waitFor(() => {
      expect(screen.getByTestId("sam-track-add-object")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("sam-track-add-object"));
    await waitFor(() => {
      expect(samTrackApi.addObject).toHaveBeenCalledWith(
        "asset-vid-1",
        "S-1",
        expect.objectContaining({ frame_idx: 0, obj_id: 1, labels: [1] }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument();
    });
  });

  it("Propagate calls samTrackApi.step with the configured frame count", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_id: 1,
      frame_idx: 0,
    });
    // v3.8 Phase 4.1 — auto-loop: first call returns frames, second
    // returns empty so the loop terminates without OOM.
    (samTrackApi.step as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        steps: [
          {
            frame_idx: 0,
            objects: [
              { obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0, polygon: [] },
            ],
          },
          {
            frame_idx: 1,
            objects: [
              { obj_id: 1, counts: "0,3", size: [4, 4], score: 1.0, polygon: [] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ steps: [] });
    useTool.setState({ activeClassId: "c-A" });
    renderPanel();
    fireEvent.click(screen.getByTestId("sam-track-start"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-add-object")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-add-object"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-to-end"));
    await waitFor(() => {
      expect(samTrackApi.step).toHaveBeenCalledWith("asset-vid-1", "S-1", 8);
    });
  });

  it("Commit creates a mask draft for the current frame and releases the session", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_id: 1,
      frame_idx: 0,
    });
    (samTrackApi.step as ReturnType<typeof vi.fn>).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [{ obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 }],
        },
      ],
    });
    (samTrackApi.release as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    useTool.setState({ activeClassId: "c-A" });
    renderPanel({ frameId: "frame-id-0", currentFrameIdx: 0 });
    fireEvent.click(screen.getByTestId("sam-track-start"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-add-object")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-add-object"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument(),
    );
    // v3.8 Phase 4.1 -- "Track to end" auto-loops step until the
    // model returns no more frames; the mock above returns one frame
    // per call so the second call returns empty and breaks the loop.
    (samTrackApi.step as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        steps: [
          {
            frame_idx: 0,
            objects: [
              { obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0, polygon: [] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ steps: [] });
    fireEvent.click(screen.getByTestId("sam-track-to-end"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-progress")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-commit"));
    await waitFor(() => {
      const drafts = Object.values(useAnnotations.getState().byId);
      expect(drafts.length).toBeGreaterThanOrEqual(1);
      // Polygon is preferred when available; the mock returns an
      // empty polygon so the draft falls back to mask.
      expect(["polygon", "mask"]).toContain(drafts[0].kind);
      expect(drafts[0].frameId).toBe("frame-id-0");
    });
    await waitFor(() => {
      expect(samTrackApi.release).toHaveBeenCalled();
    });
  });

  it("Discard releases the server session and resets the panel UI", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.release as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("sam-track-start"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-discard")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-discard"));
    await waitFor(() => {
      expect(samTrackApi.release).toHaveBeenCalledWith("asset-vid-1", "S-1");
    });
    // Back to the pre-session UI: Start button visible again.
    await waitFor(() => {
      expect(screen.getByTestId("sam-track-start")).toBeInTheDocument();
    });
  });
});

// --- v3.6 — canvas teach-back through the SamTrack bridge -----------------

describe("SamTrackPanel — canvas click teach-back (v3.6)", () => {
  function renderPanel() {
    return render(
      wrap(
        <SamTrackPanel
          assetId="asset-vid-1"
          frameId="frame-id-0"
          currentFrameIdx={0}
          totalFrames={100}
        />,
      ),
    );
  }

  it("registers a canvas-click handler on the bridge while mounted", () => {
    expect(useSamTrackBridge.getState().onCanvasClick).toBeNull();
    renderPanel();
    expect(typeof useSamTrackBridge.getState().onCanvasClick).toBe("function");
  });

  it("clears the bridge handler on unmount", () => {
    const { unmount } = renderPanel();
    expect(useSamTrackBridge.getState().onCanvasClick).not.toBeNull();
    unmount();
    expect(useSamTrackBridge.getState().onCanvasClick).toBeNull();
    expect(useSamTrackBridge.getState().markers).toEqual([]);
  });

  it("canvas click auto-starts the session and adds an object at the click coords", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-77",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      obj_id: 1,
      frame_idx: 0,
    });
    useTool.setState({ activeClassId: "c-X" });
    renderPanel();

    // Simulate the canvas dispatching a click in track mode through the bridge.
    const handler = useSamTrackBridge.getState().onCanvasClick;
    expect(handler).not.toBeNull();
    await act(async () => {
      handler!([123, 456]);
    });

    // Auto-start path: a /sam/track/start should fire because no session is open.
    await waitFor(() => {
      expect(samTrackApi.start).toHaveBeenCalledWith("asset-vid-1", 0, [], []);
    });
    // addObject should be called with the click coords as a positive prompt.
    await waitFor(() => {
      expect(samTrackApi.addObject).toHaveBeenCalledWith(
        "asset-vid-1",
        "S-77",
        expect.objectContaining({
          frame_idx: 0,
          obj_id: 1,
          points: [[123, 456]],
          labels: [1],
        }),
      );
    });
    // The panel publishes a marker so the canvas can paint a numbered dot.
    await waitFor(() => {
      const markers = useSamTrackBridge.getState().markers;
      expect(markers).toEqual([{ objId: 1, x: 123, y: 456 }]);
    });
  });

  it("subsequent canvas clicks add more objects without re-starting the session", async () => {
    (samTrackApi.start as ReturnType<typeof vi.fn>).mockResolvedValue({
      session_id: "S-1",
      mask_at_start: { counts: "", size: [0, 0] },
    });
    (samTrackApi.addObject as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ obj_id: 1, frame_idx: 0 })
      .mockResolvedValueOnce({ obj_id: 2, frame_idx: 0 });
    useTool.setState({ activeClassId: "c-X" });
    renderPanel();

    const handler = useSamTrackBridge.getState().onCanvasClick!;
    await act(async () => {
      handler([10, 20]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-object-1")).toBeInTheDocument(),
    );
    await act(async () => {
      handler([30, 40]);
    });
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-object-2")).toBeInTheDocument(),
    );

    // start should fire once; addObject twice with each click's coords.
    expect(samTrackApi.start).toHaveBeenCalledTimes(1);
    expect(samTrackApi.addObject).toHaveBeenCalledTimes(2);
    const markers = useSamTrackBridge.getState().markers;
    expect(markers).toEqual([
      { objId: 1, x: 10, y: 20 },
      { objId: 2, x: 30, y: 40 },
    ]);
  });
});

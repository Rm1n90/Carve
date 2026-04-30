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
    (samTrackApi.step as ReturnType<typeof vi.fn>).mockResolvedValue({
      steps: [
        {
          frame_idx: 0,
          objects: [{ obj_id: 1, counts: "0,2", size: [4, 4], score: 1.0 }],
        },
        {
          frame_idx: 1,
          objects: [{ obj_id: 1, counts: "0,3", size: [4, 4], score: 1.0 }],
        },
      ],
    });
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
    // Default step count is 5; change to 2 to make the assertion explicit.
    const input = screen.getByTestId("sam-track-step-frames");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("sam-track-propagate"));
    await waitFor(() => {
      expect(samTrackApi.step).toHaveBeenCalledWith("asset-vid-1", "S-1", 2);
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
    fireEvent.click(screen.getByTestId("sam-track-propagate"));
    await waitFor(() =>
      expect(screen.getByTestId("sam-track-progress")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sam-track-commit"));
    await waitFor(() => {
      const drafts = Object.values(useAnnotations.getState().byId);
      expect(drafts.length).toBeGreaterThanOrEqual(1);
      expect(drafts[0].kind).toBe("mask");
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

/**
 * v3.5 Phase D — SAM tool mode tests.
 *
 * Two layers:
 *   1. SamTool unit tests — setMode + setText/setBox call the right
 *      samApi method with the right arguments and mode-gating works
 *      (e.g. setBox in text mode is a no-op).
 *   2. SamModePicker integration tests — chips render only when the
 *      SAM tool is active; text + box are disabled on SAM 2 variants
 *      and enabled on SAM 3.
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

vi.mock("@/api/sam", () => ({
  samApi: {
    encode: vi.fn(),
    decode: vi.fn(),
    textPrompt: vi.fn(),
    boxPrompt: vi.fn(),
  },
}));

// EditorToolbar pulls the SAM picker (samActive) and the YOLO predict
// popover. Mock both so the component renders standalone.
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

import { samApi } from "@/api/sam";
import { modelsApi } from "@/api/phase2";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { SamTool } from "@/canvas/tools/SamTool";
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
  // Reset the tool store between tests so a previous test that flipped
  // the tool / mode doesn't bleed into the next one.
  useTool.setState({ active: "cursor", samMode: "point" });
});

afterEach(() => {
  cleanup();
});

// --- SamTool unit tests ----------------------------------------------------

describe("SamTool — setMode / setText / setBox", () => {
  it("setMode('text') + setText('person') calls samApi.textPrompt", async () => {
    (samApi.textPrompt as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        counts: "0,2,2,2,10",
        size: [4, 4],
        score: 0.91,
        bbox: [1, 2, 3, 4],
      },
    ]);

    const tool = new SamTool("asset-1", () => "c-1", () => null);
    tool.setMode("text");
    expect(tool.getMode()).toBe("text");
    const result = await tool.setText("person");
    expect(samApi.textPrompt).toHaveBeenCalledWith("asset-1", "person");
    expect(result).not.toBeNull();
    expect(result?.score).toBe(0.91);
  });

  it("setMode('box') + setBox(...) calls samApi.boxPrompt with positive label", async () => {
    (samApi.boxPrompt as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        counts: "0,4,4,4,12",
        size: [8, 8],
        score: 0.83,
        bbox: [10, 20, 30, 40],
      },
    ]);

    const tool = new SamTool("asset-2", () => "c-1", () => null);
    tool.setMode("box");
    const result = await tool.setBox([10, 20, 30, 40]);
    expect(samApi.boxPrompt).toHaveBeenCalledWith(
      "asset-2",
      [[10, 20, 30, 40]],
      [1],
    );
    expect(result?.bbox).toEqual([10, 20, 30, 40]);
  });

  it("setText is a no-op when not in text mode", async () => {
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("point");
    const result = await tool.setText("person");
    expect(result).toBeNull();
    expect(samApi.textPrompt).not.toHaveBeenCalled();
  });

  it("setBox is a no-op when not in box mode", async () => {
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("text");
    const result = await tool.setBox([0, 0, 10, 10]);
    expect(result).toBeNull();
    expect(samApi.boxPrompt).not.toHaveBeenCalled();
  });

  it("setMode resets accumulated point clicks so old state doesn't leak", async () => {
    (samApi.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      image_hash: "h".repeat(32),
      shape: [10, 10],
    });
    (samApi.decode as ReturnType<typeof vi.fn>).mockResolvedValue({
      counts: "0,1,1",
      size: [10, 10],
      score: 0.5,
    });

    const tool = new SamTool("a", () => "c-1", () => null);
    await tool.activate();
    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });
    expect((samApi.decode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // Switch modes — the accumulated positive should drop, and a
    // subsequent setText shouldn't carry it.
    tool.setMode("text");
    expect(tool.getMode()).toBe("text");
  });

  it("setText after setMode commits the resulting mask via commit()", async () => {
    (samApi.textPrompt as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        counts: "0,2,2,2,10",
        size: [4, 4],
        score: 0.7,
        bbox: [0, 0, 1, 1],
      },
    ]);
    let n = 0;
    const tool = new SamTool(
      "a",
      () => "c-1",
      () => null,
      () => `t-${++n}`,
    );
    tool.setMode("text");
    await tool.setText("dog");
    const ok = tool.commit();
    expect(ok).toBe(true);
    const drafts = Object.values(useAnnotations.getState().byId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("mask");
    const g = drafts[0].geometry as {
      kind: string;
      size: [number, number];
      counts: string;
    };
    expect(g.kind).toBe("mask_rle");
    expect(g.counts).toBe("0,2,2,2,10");
  });

  it("box mode picks the highest-score candidate when the model returns multiple", async () => {
    (samApi.boxPrompt as ReturnType<typeof vi.fn>).mockResolvedValue([
      { counts: "lo", size: [4, 4], score: 0.3, bbox: [0, 0, 1, 1] },
      { counts: "hi", size: [4, 4], score: 0.9, bbox: [0, 0, 1, 1] },
      { counts: "mid", size: [4, 4], score: 0.6, bbox: [0, 0, 1, 1] },
    ]);
    const tool = new SamTool("a", () => "c-1", () => null);
    tool.setMode("box");
    const r = await tool.setBox([0, 0, 1, 1]);
    expect(r?.score).toBe(0.9);
    expect(r?.counts).toBe("hi");
  });
});

// --- SamModePicker integration tests --------------------------------------

describe("SamModePicker (EditorToolbar)", () => {
  function renderToolbar() {
    return render(
      wrap(
        <EditorToolbar
          onSave={vi.fn()}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
        />,
      ),
    );
  }

  it("does NOT render the mode picker when the SAM tool is inactive", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam2.1-base+",
      available: ["sam2.1-base+"],
      reachable: true,
    });
    useTool.setState({ active: "cursor" });
    renderToolbar();
    expect(screen.queryByTestId("sam-mode-picker")).toBeNull();
  });

  it("disables Text + Box chips when the active variant is SAM 2", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam2.1-large",
      available: ["sam2.1-large", "sam3"],
      reachable: true,
    });
    useTool.setState({ active: "sam" });
    renderToolbar();
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    const point = screen.getByTestId("sam-mode-point");
    expect(point).not.toBeDisabled();
    await waitFor(() => {
      const box = screen.getByTestId("sam-mode-box");
      const text = screen.getByTestId("sam-mode-text");
      expect(box).toBeDisabled();
      expect(text).toBeDisabled();
      expect(box.getAttribute("data-disabled")).toBe("true");
      expect(text.getAttribute("data-disabled")).toBe("true");
    });
  });

  it("enables Text + Box chips when the active variant is SAM 3", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam3",
      available: ["sam3"],
      reachable: true,
    });
    useTool.setState({ active: "sam" });
    renderToolbar();
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    await waitFor(() => {
      const box = screen.getByTestId("sam-mode-box");
      const text = screen.getByTestId("sam-mode-text");
      expect(box).not.toBeDisabled();
      expect(text).not.toBeDisabled();
    });
  });

  it("clicking a mode chip writes the selection into the tool store", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "sam3",
      available: ["sam3"],
      reachable: true,
    });
    useTool.setState({ active: "sam", samMode: "point" });
    renderToolbar();
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-picker")).toBeInTheDocument();
    });
    // Wait for the variant query to resolve so the chip is enabled.
    await waitFor(() => {
      expect(screen.getByTestId("sam-mode-text")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("sam-mode-text"));
    expect(useTool.getState().samMode).toBe("text");
  });
});

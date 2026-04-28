import React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

// Mock the Phase 2 model APIs the toolbar pulls (the SAM picker + the
// YOLO predict popover). They're not under test here.
vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi.fn().mockResolvedValue({
      active: "sam2.1-base+",
      available: ["sam2.1-base+"],
      reachable: true,
    }),
  },
  weightsApi: {
    listForProject: vi.fn().mockResolvedValue([]),
    listWorkspace: vi.fn().mockResolvedValue([]),
  },
  inferenceApi: {
    predictYolo: vi.fn().mockResolvedValue({ count: 0 }),
  },
  trashApi: { list: vi.fn(), restore: vi.fn(), hardDelete: vi.fn() },
}));

import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { useAnnotations } from "@/state/annotations";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

interface Handlers {
  onSave: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (p: number) => void;
  onZoomActual: () => void;
  onFitToScreen: () => void;
}

function makeHandlers(): Handlers {
  return {
    onSave: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomTo: vi.fn(),
    onZoomActual: vi.fn(),
    onFitToScreen: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Reset the annotations history so the undo/redo buttons start
  // disabled and don't bleed state between tests.
  useAnnotations.setState({
    history: { past: [], future: [] },
  } as never);
});

describe("EditorToolbar zoom controls (v2.6)", () => {
  it("renders the + / − / 1:1 buttons and the % display", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={75}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    expect(screen.getByTestId("zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-out")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-actual")).toBeInTheDocument();
    expect(screen.getByTestId("zoom-percent").textContent).toContain("75%");
  });

  it("clicking the + button calls onZoomIn", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(h.onZoomIn).toHaveBeenCalledTimes(1);
  });

  it("clicking the − button calls onZoomOut", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(h.onZoomOut).toHaveBeenCalledTimes(1);
  });

  it("clicking the 1:1 button calls onZoomActual", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={50}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("zoom-actual"));
    expect(h.onZoomActual).toHaveBeenCalledTimes(1);
  });

  it("double-clicking the % display opens an inline numeric input", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={50}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.doubleClick(screen.getByTestId("zoom-percent"));
    expect(screen.getByTestId("zoom-percent-input")).toBeInTheDocument();
  });

  it("typing a number into the % input and pressing Enter calls onZoomTo with that number", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.doubleClick(screen.getByTestId("zoom-percent"));
    const input = screen.getByTestId("zoom-percent-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onZoomTo).toHaveBeenCalledWith(150);
  });

  it("Escape on the % input cancels without calling onZoomTo", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.doubleClick(screen.getByTestId("zoom-percent"));
    const input = screen.getByTestId("zoom-percent-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(h.onZoomTo).not.toHaveBeenCalled();
  });

  it("clamps the entered % to the [10, 1000] range", () => {
    const h = makeHandlers();
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
    fireEvent.doubleClick(screen.getByTestId("zoom-percent"));
    const input = screen.getByTestId("zoom-percent-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onZoomTo).toHaveBeenCalledWith(1000);
  });
});

describe("EditorToolbar zoom keyboard shortcuts (v2.6)", () => {
  function renderToolbar(h: Handlers) {
    render(
      wrap(
        <EditorToolbar
          onSave={h.onSave}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
          onZoomIn={h.onZoomIn}
          onZoomOut={h.onZoomOut}
          onZoomTo={h.onZoomTo}
          onZoomActual={h.onZoomActual}
          onFitToScreen={h.onFitToScreen}
        />,
      ),
    );
  }

  it("'+' and '=' both trigger onZoomIn", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "=" });
    expect(h.onZoomIn).toHaveBeenCalledTimes(2);
  });

  it("'-' and '_' both trigger onZoomOut", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.keyDown(window, { key: "_" });
    expect(h.onZoomOut).toHaveBeenCalledTimes(2);
  });

  it("'0' triggers onFitToScreen", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "0" });
    expect(h.onFitToScreen).toHaveBeenCalledTimes(1);
  });

  it("'1' triggers onZoomActual", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "1" });
    expect(h.onZoomActual).toHaveBeenCalledTimes(1);
  });

  it("Cmd/Ctrl + '+' triggers onZoomIn (overriding browser zoom)", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(h.onZoomIn).toHaveBeenCalledTimes(2);
  });

  it("Cmd/Ctrl + '-' triggers onZoomOut", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(h.onZoomOut).toHaveBeenCalledTimes(1);
  });

  it("Cmd/Ctrl + '0' triggers onFitToScreen", () => {
    const h = makeHandlers();
    renderToolbar(h);
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(h.onFitToScreen).toHaveBeenCalledTimes(1);
  });

  it("does not fire zoom shortcuts while typing in an input", () => {
    const h = makeHandlers();
    render(
      <div>
        <input data-testid="text-input" />
        {wrap(
          <EditorToolbar
            onSave={h.onSave}
            isSaving={false}
            hasError={false}
            dirtyCount={0}
            zoomPct={100}
            onZoomIn={h.onZoomIn}
            onZoomOut={h.onZoomOut}
            onZoomTo={h.onZoomTo}
            onZoomActual={h.onZoomActual}
            onFitToScreen={h.onFitToScreen}
          />,
        )}
      </div>,
    );
    const input = screen.getByTestId("text-input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "+" });
    fireEvent.keyDown(input, { key: "1" });
    fireEvent.keyDown(input, { key: "0" });
    expect(h.onZoomIn).not.toHaveBeenCalled();
    expect(h.onZoomActual).not.toHaveBeenCalled();
    expect(h.onFitToScreen).not.toHaveBeenCalled();
  });
});

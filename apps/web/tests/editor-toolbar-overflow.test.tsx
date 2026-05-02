import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

/**
 * Plan 14 Phase 8 Task 9 — sticky toolbar + overflow menu at <1280px.
 *
 * The toolbar listens to ``window.matchMedia("(max-width: 1279px)")``
 * and, when narrow, hides the visibility / fit-to-screen / filter /
 * editor-settings buttons in favour of a single ``…`` MoreHorizontal
 * dropdown carrying those plus the editor's cheat-sheet, command-
 * palette and info-dialog triggers.
 */

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

interface MQLStub {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: (
    type: "change",
    listener: (e: { matches: boolean }) => void,
  ) => void;
  removeEventListener: (
    type: "change",
    listener: (e: { matches: boolean }) => void,
  ) => void;
  addListener: (listener: (e: { matches: boolean }) => void) => void;
  removeListener: (listener: (e: { matches: boolean }) => void) => void;
  dispatchEvent: () => boolean;
}

function installMatchMedia(narrow: boolean): MQLStub {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const stub: MQLStub = {
    matches: narrow,
    media: "(max-width: 1279px)",
    onchange: null,
    addEventListener: (_t, l) => {
      listeners.add(l);
    },
    removeEventListener: (_t, l) => {
      listeners.delete(l);
    },
    addListener: (l) => {
      listeners.add(l);
    },
    removeListener: (l) => {
      listeners.delete(l);
    },
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (_q: string) => stub as unknown as MediaQueryList,
  });
  return stub;
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

const baseHandlers = {
  onSave: vi.fn(),
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onZoomTo: vi.fn(),
  onZoomActual: vi.fn(),
  onFitToScreen: vi.fn(),
};

beforeEach(() => {
  useAnnotations.setState({
    history: { past: [], future: [] },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EditorToolbar responsive overflow (Plan 14 Task 9)", () => {
  it("at >=1280px shows visibility / filter / settings inline and no overflow trigger", () => {
    installMatchMedia(false);
    render(
      wrap(
        <EditorToolbar
          {...baseHandlers}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
        />,
      ),
    );
    expect(screen.getByTestId("visibility-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("filter-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("editor-settings-trigger")).toBeInTheDocument();
    expect(
      screen.queryByTestId("editor-toolbar-overflow-trigger"),
    ).not.toBeInTheDocument();
  });

  it("at <1280px hides the inline less-used buttons and shows the overflow trigger", () => {
    installMatchMedia(true);
    render(
      wrap(
        <EditorToolbar
          {...baseHandlers}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
        />,
      ),
    );
    expect(
      screen.queryByTestId("visibility-trigger"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-trigger")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("editor-settings-trigger"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("editor-toolbar-overflow-trigger"),
    ).toBeInTheDocument();
  });

  it("opening the overflow menu surfaces the collapsed actions", async () => {
    installMatchMedia(true);
    render(
      wrap(
        <EditorToolbar
          {...baseHandlers}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
        />,
      ),
    );
    const trigger = screen.getByTestId("editor-toolbar-overflow-trigger");
    // Radix DropdownMenu's open semantics in jsdom require either a real
    // pointer-event sequence with a non-mouse pointer type or a keyboard
    // activation. ``keyDown Enter`` is the most reliable in this env.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByTestId("overflow-fit-to-screen")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-visibility")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-filter")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-cheatsheet")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-command-palette")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-info")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-settings")).toBeInTheDocument();
  });

  it("the toolbar root is sticky-positioned at the top of its container", () => {
    installMatchMedia(false);
    render(
      wrap(
        <EditorToolbar
          {...baseHandlers}
          isSaving={false}
          hasError={false}
          dirtyCount={0}
          zoomPct={100}
        />,
      ),
    );
    const toolbar = screen.getByTestId("editor-toolbar");
    expect(toolbar.className).toContain("sticky");
    expect(toolbar.className).toContain("top-0");
  });
});

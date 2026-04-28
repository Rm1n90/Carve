import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen, act } from "@testing-library/react";
import {
  useResizableRightPanel,
  STORAGE_KEY,
  MIN_WIDTH_PX,
  MAX_WIDTH_PX,
  DEFAULT_WIDTH_PX,
  clampPanelWidth,
} from "@/hooks/useResizableRightPanel";

/**
 * jsdom does not implement the PointerEvent constructor; @testing-library's
 * `fireEvent.pointerDown` polyfill synthesises an Event without `clientX`
 * propagating reliably through React 19's synthetic event boundary. The
 * hook only reads `clientX` and `button`, both of which MouseEvent supplies,
 * so we dispatch a MouseEvent with `type: "pointerdown"` and friends.
 */
function dispatchPointerDown(
  target: Element,
  init: { clientX: number; button?: number },
) {
  const ev = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX,
  });
  act(() => {
    target.dispatchEvent(ev);
  });
}
function dispatchPointerMove(clientX: number) {
  const ev = new MouseEvent("pointermove", { bubbles: true, clientX });
  act(() => {
    window.dispatchEvent(ev);
  });
}
function dispatchPointerUp(clientX: number) {
  const ev = new MouseEvent("pointerup", { bubbles: true, clientX });
  act(() => {
    window.dispatchEvent(ev);
  });
}

/**
 * Editor wrapper that mirrors the production layout: a flex row with a 4px
 * resize handle next to a fixed-width aside. Pulling in the full
 * `AnnotateAssetPage` would drag in TanStack Router + React Query +
 * AnnotationCanvas; this thin wrapper isolates the resize behaviour.
 */
function EditorRightPanelHarness() {
  const rightPanel = useResizableRightPanel();
  return (
    <div style={{ display: "flex", height: 600 }}>
      <main data-testid="canvas-area" style={{ flex: 1 }} />
      <div
        data-testid="right-panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize classes panel"
        ref={rightPanel.handleRef}
        style={{ width: 4, cursor: "col-resize" }}
        data-dragging={rightPanel.isDragging ? "true" : "false"}
      />
      <aside
        role="complementary"
        aria-label="Classes"
        data-testid="right-panel-aside"
        style={{ width: `${rightPanel.width}px` }}
      >
        <button data-testid="panel-row">click me</button>
      </aside>
    </div>
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function readPanelWidth(): number {
  const aside = screen.getByTestId("right-panel-aside") as HTMLElement;
  // jsdom returns the inline style verbatim; that's what we set.
  const px = aside.style.width;
  return Number(px.replace("px", ""));
}

describe("useResizableRightPanel — clampPanelWidth", () => {
  it("returns the input rounded for in-range values", () => {
    expect(clampPanelWidth(320, 1920)).toBe(320);
    expect(clampPanelWidth(380.7, 1920)).toBe(381);
  });

  it("clamps below MIN_WIDTH_PX", () => {
    expect(clampPanelWidth(100, 1920)).toBe(MIN_WIDTH_PX);
    expect(clampPanelWidth(0, 1920)).toBe(MIN_WIDTH_PX);
    expect(clampPanelWidth(-50, 1920)).toBe(MIN_WIDTH_PX);
  });

  it("clamps above MAX_WIDTH_PX on a wide viewport", () => {
    expect(clampPanelWidth(800, 1920)).toBe(MAX_WIDTH_PX);
    expect(clampPanelWidth(2000, 1920)).toBe(MAX_WIDTH_PX);
  });

  it("clamps at half-viewport on a narrow viewport", () => {
    // 800px viewport → max should be 400px (half), not the global 600px.
    expect(clampPanelWidth(550, 800)).toBe(400);
    expect(clampPanelWidth(2000, 800)).toBe(400);
  });
});

describe("useResizableRightPanel — pointer drag", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportWidth(1920);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("starts at DEFAULT_WIDTH_PX when no value is persisted", () => {
    render(<EditorRightPanelHarness />);
    expect(readPanelWidth()).toBe(DEFAULT_WIDTH_PX);
  });

  it("drag widens the panel when moving the handle LEFT (negative dx)", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    // Start drag at clientX=1600. Moving left to clientX=1500 should
    // widen the panel by 100px → 320 + 100 = 420.
    dispatchPointerDown(handle, { clientX: 1600 });
    dispatchPointerMove(1500);
    expect(readPanelWidth()).toBe(420);
    dispatchPointerUp(1500);
  });

  it("drag narrows the panel when moving the handle RIGHT (positive dx)", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 1600 });
    dispatchPointerMove(1640);
    // 320 - 40 = 280
    expect(readPanelWidth()).toBe(280);
    dispatchPointerUp(1640);
  });

  it("clamps to MIN_WIDTH_PX when narrowed past the floor", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 1600 });
    // huge positive dx → tries to narrow far below MIN_WIDTH_PX
    dispatchPointerMove(5000);
    expect(readPanelWidth()).toBe(MIN_WIDTH_PX);
    dispatchPointerUp(5000);
  });

  it("clamps to MAX_WIDTH_PX when widened past the ceiling on a wide viewport", () => {
    setViewportWidth(2400); // half-viewport (1200) > MAX_WIDTH_PX so global cap dominates.
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 2000 });
    dispatchPointerMove(0);
    expect(readPanelWidth()).toBe(MAX_WIDTH_PX);
    dispatchPointerUp(0);
  });

  it("clamps to half-viewport on narrow displays", () => {
    setViewportWidth(800); // half = 400, smaller than MAX_WIDTH_PX(600)
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 600 });
    dispatchPointerMove(0);
    expect(readPanelWidth()).toBe(400);
    dispatchPointerUp(0);
  });

  it("persists the chosen width to localStorage on pointerup", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 1600 });
    dispatchPointerMove(1500);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    dispatchPointerUp(1500);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("420");
  });

  it("rehydrates the width from localStorage on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "480");
    render(<EditorRightPanelHarness />);
    expect(readPanelWidth()).toBe(480);
  });

  it("ignores non-primary buttons", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 1600, button: 2 });
    dispatchPointerMove(1400);
    expect(readPanelWidth()).toBe(DEFAULT_WIDTH_PX);
  });

  it("re-clamps the width when the viewport is shrunk past 2× the panel width", () => {
    window.localStorage.setItem(STORAGE_KEY, "500");
    setViewportWidth(1920);
    render(<EditorRightPanelHarness />);
    expect(readPanelWidth()).toBe(500);
    act(() => {
      setViewportWidth(800); // half = 400
      window.dispatchEvent(new Event("resize"));
    });
    expect(readPanelWidth()).toBe(400);
  });

  it("clears document body cursor / user-select after pointerup", () => {
    render(<EditorRightPanelHarness />);
    const handle = screen.getByTestId("right-panel-resize-handle");
    dispatchPointerDown(handle, { clientX: 1600 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    dispatchPointerUp(1600);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("does not block clicks on the underlying panel rows", () => {
    let clicks = 0;
    function Wrapper() {
      const rp = useResizableRightPanel();
      return (
        <div style={{ display: "flex" }}>
          <div
            data-testid="right-panel-resize-handle"
            ref={rp.handleRef}
            style={{ width: 4 }}
          />
          <aside style={{ width: rp.width }}>
            <button
              data-testid="row"
              onClick={() => {
                clicks += 1;
              }}
            >
              row
            </button>
          </aside>
        </div>
      );
    }
    render(<Wrapper />);
    fireEvent.click(screen.getByTestId("row"));
    expect(clicks).toBe(1);
  });
});

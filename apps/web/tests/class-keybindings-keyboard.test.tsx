/**
 * Keyboard contract for class digit shortcuts.
 *
 *   Plain digit → activates the bound class.
 *   Shift+digit (with an active class):
 *     - if the digit isn't bound to the active class → bind.
 *     - if the digit IS bound to the active class    → unbind.
 *   Shift+digit (no active class) → info toast, no mutation.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// useTool: shape it to expose getState/setState/subscribe + a callable
// hook. Per-test we mutate getState() to flip activeClassId.
const toolState = { activeClassId: "c-2", setActiveClassId: vi.fn() };
vi.mock("@/state/tool", () => ({
  useTool: Object.assign(
    (selector?: (s: typeof toolState) => unknown) =>
      selector ? selector(toolState) : toolState,
    {
      getState: () => toolState,
      setState: () => undefined,
      subscribe: () => () => undefined,
    },
  ),
}));

const putMock = vi.fn().mockResolvedValue({});
const removeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/api/keybindings", () => ({
  keybindingsApi: {
    list: vi.fn().mockResolvedValue({ bindings: [] }),
    put: (...args: unknown[]) => putMock(...args),
    remove: (...args: unknown[]) => removeMock(...args),
  },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

const CLASSES = [
  { id: "c-1", project_id: "p", name: "Bus", color: "#ff0000", idx: 0 },
  { id: "c-2", project_id: "p", name: "Car", color: "#00ff00", idx: 1 },
] as never;

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  toolState.activeClassId = "c-2";
  toolState.setActiveClassId.mockClear();
  putMock.mockClear();
  removeMock.mockClear();
  showToastMock.mockClear();
});
afterEach(cleanup);

describe("ClassesPanel keyboard", () => {
  it("plain digit activates the bound class from digitToClassId", () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    fireEvent.keyDown(window, { key: "1" });
    expect(toolState.setActiveClassId).toHaveBeenCalledWith("c-1");
  });

  it("Shift+digit with an active class dispatches put", async () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    // Active class is c-2; binding it to digit 5 → PUT("p", 5, "c-2").
    // Real keyboards send e.key="%" with shift+5 (shifted character)
    // and e.code="Digit5". The handler reads e.code so the shifted-
    // character e.key doesn't prevent detection.
    fireEvent.keyDown(window, {
      key: "%", code: "Digit5", shiftKey: true,
    });
    await act(async () => { await Promise.resolve(); });
    expect(putMock).toHaveBeenCalledWith("p", 5, "c-2");
  });

  it("Shift+digit on the active class's CURRENT digit unbinds", async () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    // c-2 is currently at digit 2; Shift+2 should unbind.
    fireEvent.keyDown(window, {
      key: "@", code: "Digit2", shiftKey: true,
    });
    await act(async () => { await Promise.resolve(); });
    expect(removeMock).toHaveBeenCalledWith("p", 2);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("Shift+digit with no active class shows the prompt toast", () => {
    toolState.activeClassId = null as unknown as string;
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{}}
      />,
    ));
    fireEvent.keyDown(window, {
      key: "!", code: "Digit1", shiftKey: true,
    });
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringMatching(/Select a class first/i),
      expect.anything(),
    );
    expect(putMock).not.toHaveBeenCalled();
  });

  // --- Regression for the "Im doing that but nothing happening" bug ---
  // Pre-fix the handler matched only ``/^[1-9]$/.test(e.key)``. Real
  // keyboards send e.key="!@#$%^&*(" for Shift+1..9 on US layouts (and
  // other characters on other layouts), so the regex never matched and
  // the bind path was unreachable from a real keyboard.

  it("Shift+digit fires bind path when e.key is the SHIFTED character (real keyboard)", async () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    fireEvent.keyDown(window, {
      key: "*", code: "Digit8", shiftKey: true,
    });
    await act(async () => { await Promise.resolve(); });
    expect(putMock).toHaveBeenCalledWith("p", 8, "c-2");
  });

  it("Shift+Numpad digit also fires bind path", async () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    fireEvent.keyDown(window, {
      key: "7", code: "Numpad7", shiftKey: true,
    });
    await act(async () => { await Promise.resolve(); });
    expect(putMock).toHaveBeenCalledWith("p", 7, "c-2");
  });

  it("plain digit works with the new e.code-first detection", () => {
    render(wrap(
      <ClassesPanel
        classes={CLASSES}
        digitToClassId={{ 1: "c-1", 2: "c-2" }}
      />,
    ));
    fireEvent.keyDown(window, { key: "2", code: "Digit2" });
    expect(toolState.setActiveClassId).toHaveBeenCalledWith("c-2");
  });
});

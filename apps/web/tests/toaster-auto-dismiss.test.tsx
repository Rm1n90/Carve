// Armin Mehri — mehri.armin@gmail.com
//
// Regression: bottom-right toasts sometimes stayed on screen until the
// user clicked the X button. Root cause was Radix's built-in auto-close
// timer, which pauses while the viewport is hovered or the window
// loses focus. The Toaster now owns its own setTimeout per toast so
// every notification dismisses on the same schedule regardless of
// pointer-hover or focus state.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Toaster } from "../src/components/ui/Toaster";
import { showToast, _resetToastBusForTests } from "../src/lib/toast";

describe("Toaster auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetToastBusForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    _resetToastBusForTests();
  });

  it("dismisses every toast after the default duration", async () => {
    render(<Toaster />);

    await act(async () => {
      showToast("hello", { variant: "info" });
    });

    expect(screen.getByText("hello")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(screen.queryByText("hello")).toBeNull();
  });

  it("honours custom durations", async () => {
    render(<Toaster />);

    await act(async () => {
      showToast("quick", { variant: "info", duration: 1200 });
    });

    expect(screen.getByText("quick")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText("quick")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByText("quick")).toBeNull();
  });

  it("treats non-finite or non-positive durations as the default", async () => {
    render(<Toaster />);

    await act(async () => {
      showToast("infinite-like", { variant: "info", duration: 0 });
    });

    expect(screen.getByText("infinite-like")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(screen.queryByText("infinite-like")).toBeNull();
  });

  it("dismisses multiple stacked toasts independently", async () => {
    render(<Toaster />);

    await act(async () => {
      showToast("first", { variant: "info", duration: 1000 });
      showToast("second", { variant: "info", duration: 2000 });
    });

    expect(screen.getByText("first")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByText("second")).toBeNull();
  });
});

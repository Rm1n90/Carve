import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";

describe("FrameTimeline", () => {
  it("renders nothing when totalFrames <= 1", () => {
    const { container } = render(
      <FrameTimeline totalFrames={1} currentIdx={0} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one button per frame and clicking jumps to that index", () => {
    const onChange = vi.fn();
    render(
      <FrameTimeline totalFrames={4} currentIdx={0} onChange={onChange} />,
    );
    // v3.8 Phase 4-video step F3 -- timeline now also has prev/next
    // nav buttons in addition to the per-frame stripes.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4 + 2);
    // The first two are the prev/next nav; frame buttons start at index 2.
    fireEvent.click(buttons[2 + 2]);
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it("`]` advances frame; `[` goes back", () => {
    const onChange = vi.fn();
    render(
      <FrameTimeline totalFrames={4} currentIdx={1} onChange={onChange} />,
    );
    fireEvent.keyDown(window, { key: "]" });
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.keyDown(window, { key: "[" });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("does not advance past last frame", () => {
    const onChange = vi.fn();
    render(
      <FrameTimeline totalFrames={3} currentIdx={2} onChange={onChange} />,
    );
    fireEvent.keyDown(window, { key: "]" });
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

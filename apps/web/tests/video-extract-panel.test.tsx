// Armin Mehri — mehri.armin@gmail.com
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import {
  VideoExtractPanel,
  DEFAULT_EXTRACT_STRATEGY,
  type ExtractStrategy,
} from "@/components/annotation/VideoExtractPanel";

describe("VideoExtractPanel", () => {
  it("renders the video count header (singular)", () => {
    render(
      <VideoExtractPanel
        videoCount={1}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/1 video\b/i)).toBeInTheDocument();
  });

  it("renders the video count header (plural)", () => {
    render(
      <VideoExtractPanel
        videoCount={3}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/3 videos/i)).toBeInTheDocument();
  });

  it("calls onChange when strategy radio changes", () => {
    const onChange = vi.fn();
    render(
      <VideoExtractPanel
        videoCount={1}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("frame-extract-strategy-all"));
    const last = onChange.mock.calls.at(-1)?.[0] as ExtractStrategy;
    expect(last.strategy).toBe("all");
  });

  it("only shows the N input when strategy needs it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <VideoExtractPanel
        videoCount={1}
        value={{ strategy: "auto", n: null, quality: 75 }}
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("frame-extract-n")).toBeNull();

    rerender(
      <VideoExtractPanel
        videoCount={1}
        value={{ strategy: "count", n: 250, quality: 75 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("frame-extract-n")).toBeInTheDocument();
  });

  it("calls onChange when quality slider moves", () => {
    const onChange = vi.fn();
    render(
      <VideoExtractPanel
        videoCount={1}
        value={DEFAULT_EXTRACT_STRATEGY}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("frame-extract-quality"), {
      target: { value: "90" },
    });
    const last = onChange.mock.calls.at(-1)?.[0] as ExtractStrategy;
    expect(last.quality).toBe(90);
  });
});

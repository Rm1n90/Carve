// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThumbContextMenu } from "../ThumbContextMenu";

describe("ThumbContextMenu", () => {
  it("renders only when open", () => {
    const { rerender } = render(
      <ThumbContextMenu open={false} x={10} y={10} onClose={() => {}} onCopy={() => {}} />,
    );
    expect(screen.queryByTestId("thumb-context-menu")).not.toBeInTheDocument();
    rerender(
      <ThumbContextMenu open x={10} y={10} onClose={() => {}} onCopy={() => {}} />,
    );
    expect(screen.getByTestId("thumb-context-menu")).toBeInTheDocument();
  });

  it("calls onCopy then onClose when the copy item is clicked", () => {
    const onCopy = vi.fn();
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={onCopy} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("thumb-context-menu-copy"));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on outside mousedown", () => {
    const onClose = vi.fn();
    render(<ThumbContextMenu open x={50} y={50} onCopy={() => {}} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

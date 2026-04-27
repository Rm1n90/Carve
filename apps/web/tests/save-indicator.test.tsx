import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SaveIndicator } from "@/components/annotation/SaveIndicator";

describe("SaveIndicator", () => {
  it("renders 'Saved' state when nothing is dirty", () => {
    render(<SaveIndicator isSaving={false} hasError={false} dirtyCount={0} />);
    expect(screen.getByTestId("save-indicator")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
  });

  it("renders 'Unsaved changes' state with amber dot when dirtyCount > 0", () => {
    render(<SaveIndicator isSaving={false} hasError={false} dirtyCount={3} />);
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("data-state", "dirty");
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it("renders 'Saving…' with spinner when saving", () => {
    render(<SaveIndicator isSaving={true} hasError={false} dirtyCount={1} />);
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("data-state", "saving");
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
  });

  it("renders 'Save failed' with retry button on error", () => {
    const onRetry = vi.fn();
    render(
      <SaveIndicator isSaving={false} hasError={true} dirtyCount={1} onRetry={onRetry} />,
    );
    const btn = screen.getByTestId("save-indicator");
    expect(btn).toHaveAttribute("data-state", "error");
    expect(screen.getByText(/save failed/i)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

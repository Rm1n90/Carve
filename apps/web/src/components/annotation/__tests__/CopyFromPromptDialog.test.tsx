// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyFromPromptDialog } from "../CopyFromPromptDialog";

describe("CopyFromPromptDialog", () => {
  it("calls onPick with the entered ordinal on Enter for a valid value", () => {
    const onPick = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={() => {}}
        totalAssets={1247}
        currentOrdinal={98}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(42);
  });

  it("rejects ordinals out of range and keeps the dialog open", () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={onOpenChange}
        totalAssets={10}
        currentOrdinal={5}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("copy-prompt-error")).toBeInTheDocument();
  });

  it("rejects when the entered ordinal equals currentOrdinal", () => {
    const onPick = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={() => {}}
        totalAssets={10}
        currentOrdinal={5}
        onPick={onPick}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy-prompt-error").textContent).toMatch(/same as current/i);
  });

  it("dismisses on Escape", () => {
    const onOpenChange = vi.fn();
    render(
      <CopyFromPromptDialog
        open
        onOpenChange={onOpenChange}
        totalAssets={10}
        currentOrdinal={5}
        onPick={vi.fn()}
      />,
    );
    const input = screen.getByTestId("copy-prompt-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

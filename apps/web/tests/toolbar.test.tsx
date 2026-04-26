import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toolbar } from "@/components/annotation/Toolbar";
import { useTool } from "@/state/tool";

describe("Toolbar", () => {
  beforeEach(() => useTool.getState().setActive("cursor"));

  it("clicking the bbox button activates bbox tool", () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByLabelText(/Bounding box \(B\)/));
    expect(useTool.getState().active).toBe("bbox");
  });

  it("hotkey 'B' activates bbox tool", () => {
    render(<Toolbar />);
    fireEvent.keyDown(window, { key: "B" });
    expect(useTool.getState().active).toBe("bbox");
  });

  it("hotkey ignored while typing in an input", () => {
    render(
      <div>
        <input data-testid="text" />
        <Toolbar />
      </div>,
    );
    const input = screen.getByTestId("text") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "B" });
    expect(useTool.getState().active).toBe("cursor");
  });
});

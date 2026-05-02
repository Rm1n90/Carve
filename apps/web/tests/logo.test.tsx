import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Logo } from "@/components/brand/Logo";

describe("Logo", () => {
  it("renders the full variant with an SVG mark", () => {
    const { container } = render(<Logo variant="full" />);
    expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders the mark variant", () => {
    const { container } = render(<Logo variant="mark" />);
    expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders the stacked variant with mark + wordmark", () => {
    const { container } = render(<Logo variant="stacked" size={48} />);
    expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("applies the default aria-label and respects overrides", () => {
    const { rerender } = render(<Logo variant="full" />);
    expect(screen.getByTestId("brand-logo")).toHaveAttribute(
      "aria-label",
      "Carve — VisualAutoAnnotator",
    );

    rerender(<Logo variant="full" ariaLabel="Custom label" />);
    expect(screen.getByTestId("brand-logo")).toHaveAttribute(
      "aria-label",
      "Custom label",
    );
  });
});

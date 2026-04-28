import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Dialog primitive (audit bug A)", () => {
  it("does not render the dialog content when open=false", () => {
    render(
      <Dialog open={false} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Stuck dialog</DialogTitle>
          <DialogDescription>Should not be visible</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Stuck dialog")).toBeNull();
  });

  it("renders the dialog content when open=true", () => {
    render(
      <Dialog open={true} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Open dialog</DialogTitle>
          <DialogDescription>Visible</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    // Radix renders the role="dialog" element on the content node.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Open dialog")).toBeInTheDocument();
  });

  it("uses glass-surface-strong (v2.9 audit P1-1)", () => {
    render(
      <Dialog open={true} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Glass dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByRole("dialog");
    expect(content.className).toContain("glass-surface-strong");
    expect(content.className).toContain("glass-specular");
  });
});

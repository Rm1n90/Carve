/**
 * v3.1 Bug 1 — Dialog + ConfirmDialog centering regression.
 *
 * Tailwind v4's `-translate-x-1/2 -translate-y-1/2` writes the modern
 * `translate` CSS property, which is independent of the `transform`
 * property the `confirm-in/out` keyframes animate. With both in play,
 * the panel was offset by (-100%, -100%) during the enter animation and
 * snapped to (-50%, -50%) only after the keyframe ended.
 *
 * Fix: drop those Tailwind classes from the panel and apply
 * `transform: translate(-50%, -50%)` inline so the property name agrees
 * with the keyframe.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import { ConfirmProvider, useConfirm } from "@/components/ui/ConfirmDialog";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Dialog primitive — v3.1 Bug 1 centering", () => {
  it("does not apply Tailwind translate-x-1/2 / translate-y-1/2 classes", () => {
    render(
      <Dialog open={true} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Centered dialog</DialogTitle>
          <DialogDescription>v3.1 Bug 1 fix</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole("dialog");
    expect(content.className).not.toMatch(/-translate-x-1\/2/);
    expect(content.className).not.toMatch(/-translate-y-1\/2/);
  });

  it("applies inline transform translate(-50%, -50%) for centering", () => {
    render(
      <Dialog open={true} onOpenChange={() => undefined}>
        <DialogContent>
          <DialogTitle>Centered dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole("dialog") as HTMLElement;
    expect(content.style.transform).toContain("translate(-50%, -50%)");
  });
});

function ConfirmHarness() {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      data-testid="confirm-trigger"
      onClick={() => {
        void confirm({ title: "Are you sure?" });
      }}
    >
      open confirm
    </button>
  );
}

describe("ConfirmDialog primitive — v3.1 Bug 1 centering", () => {
  it("does not apply Tailwind translate-x-1/2 / translate-y-1/2 classes on the panel", async () => {
    render(
      <ConfirmProvider>
        <ConfirmHarness />
      </ConfirmProvider>,
    );

    fireEvent.click(screen.getByTestId("confirm-trigger"));

    const panel = await waitFor(() => screen.getByRole("alertdialog"));
    expect(panel.className).not.toMatch(/-translate-x-1\/2/);
    expect(panel.className).not.toMatch(/-translate-y-1\/2/);
    expect((panel as HTMLElement).style.transform).toContain(
      "translate(-50%, -50%)",
    );
  });
});

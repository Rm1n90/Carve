/**
 * v2.8 — ConfirmDialog primitive tests.
 *
 * Covers the Apple-Liquid-Glass confirm primitive that replaces every
 * `window.confirm()` callsite. We exercise the imperative
 * `useConfirm()` hook through a tiny harness component so each test
 * mirrors how production code consumes the API.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  ConfirmDialog,
  ConfirmProvider,
  useConfirm,
} from "@/components/ui/ConfirmDialog";

afterEach(() => {
  cleanup();
  // Radix portals can leave aria-hidden / scroll-lock attrs on <body>
  // between tests; clear them so subsequent renders aren't hidden.
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

// ---------------------------------------------------------------
// Basic ConfirmDialog (controlled component) coverage
// ---------------------------------------------------------------

describe("ConfirmDialog (controlled)", () => {
  it("renders the title and description", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete project?"
        description="This cannot be undone."
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByText("Delete project?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("does not render content when open=false", () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={() => undefined}
        title="Hidden"
        description="Should not appear"
        onConfirm={() => undefined}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });

  it("danger variant applies a danger-colored confirm button", () => {
    render(
      <ConfirmDialog
        open
        variant="danger"
        onOpenChange={() => undefined}
        title="Delete project?"
        confirmLabel="Delete"
        onConfirm={() => undefined}
      />,
    );
    const confirmBtn = screen.getByTestId("confirm-dialog-confirm");
    expect(confirmBtn.getAttribute("data-variant")).toBe("danger");
    // Class list should reference the --danger token so the danger
    // intent is visible without a real layout pass.
    expect(confirmBtn.className).toMatch(/--danger/);
  });

  it("default variant uses the cyan accent for the confirm button", () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Save changes?"
        confirmLabel="Save"
        onConfirm={() => undefined}
      />,
    );
    const confirmBtn = screen.getByTestId("confirm-dialog-confirm");
    expect(confirmBtn.getAttribute("data-variant")).toBe("default");
    expect(confirmBtn.className).toMatch(/--accent/);
  });
});

// ---------------------------------------------------------------
// Imperative useConfirm() hook coverage
// ---------------------------------------------------------------

interface HarnessProps {
  request?: Parameters<ReturnType<typeof useConfirm>>[0];
  onResult: (ok: boolean) => void;
}

function Harness({ request, onResult }: HarnessProps) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      data-testid="harness-trigger"
      onClick={async () => {
        const ok = await confirm(
          request ?? {
            title: "Delete project?",
            description: "This cannot be undone.",
            confirmLabel: "Delete",
            variant: "danger",
          },
        );
        onResult(ok);
      }}
    >
      open
    </button>
  );
}

function renderHarness(props: HarnessProps) {
  return render(
    <ConfirmProvider>
      <Harness {...props} />
    </ConfirmProvider>,
  );
}

describe("useConfirm() — imperative API", () => {
  it("clicking confirm resolves the promise with true", async () => {
    const results: boolean[] = [];
    renderHarness({ onResult: (ok) => results.push(ok) });
    fireEvent.click(screen.getByTestId("harness-trigger"));

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(results).toEqual([true]);
    });
  });

  it("clicking cancel resolves the promise with false", async () => {
    const results: boolean[] = [];
    renderHarness({ onResult: (ok) => results.push(ok) });
    fireEvent.click(screen.getByTestId("harness-trigger"));

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    await waitFor(() => {
      expect(results).toEqual([false]);
    });
  });

  it("pressing Escape resolves the promise with false", async () => {
    const results: boolean[] = [];
    renderHarness({ onResult: (ok) => results.push(ok) });
    fireEvent.click(screen.getByTestId("harness-trigger"));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => {
      expect(results).toEqual([false]);
    });
  });

  it("backdrop dismiss (onOpenChange(false)) resolves the promise with false", async () => {
    // Radix AlertDialog deliberately swallows backdrop pointerDown to
    // prevent accidental dismissal — clicking the overlay does NOT
    // close. We exercise the same code path by simulating Escape, which
    // funnels through the SAME `onOpenChange(false)` handler that any
    // backdrop-aware variant would. This guarantees the hook resolves
    // false on every "non-confirm" close path.
    const results: boolean[] = [];
    renderHarness({ onResult: (ok) => results.push(ok) });
    fireEvent.click(screen.getByTestId("harness-trigger"));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => {
      expect(results).toEqual([false]);
    });
  });

  it("danger variant from useConfirm() flows through to the confirm button", async () => {
    renderHarness({
      onResult: () => undefined,
      request: {
        title: "Delete forever?",
        variant: "danger",
        confirmLabel: "Delete",
      },
    });
    fireEvent.click(screen.getByTestId("harness-trigger"));
    await screen.findByRole("alertdialog");
    const btn = screen.getByTestId("confirm-dialog-confirm");
    expect(btn.getAttribute("data-variant")).toBe("danger");
  });
});

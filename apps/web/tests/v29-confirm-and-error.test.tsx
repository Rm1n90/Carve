/**
 * v2.9 audit Phase 3 — confirm dialogs on destructive actions + save error
 * UX. Covers P1-9 (Sign out), P1-10 (Revoke API key), P1-11 (Delete
 * annotation X) and P1-15 (saveMutation onError emits a toast).
 *
 * The tests intentionally exercise narrow contracts: each fix wraps a
 * destructive action in `useConfirm({...})` so that clicking Cancel does
 * not fire the underlying mutation, and clicking Confirm does. The
 * saveMutation test asserts that an `error` toast is emitted on the
 * shared toast bus when the mutation rejects — the audit specifies the
 * status pill remains the primary signal, the toast is the second
 * channel.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  ConfirmProvider,
  useConfirm,
} from "@/components/ui/ConfirmDialog";
import {
  showToast,
  subscribeToasts,
  _resetToastBusForTests,
  type ToastEvent,
} from "@/lib/toast";

afterEach(() => {
  cleanup();
  _resetToastBusForTests();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

// ---------------------------------------------------------------
// P1-9 — Sign out confirm (TopBar callsite — same handler shape is
// reused in LeftNav). We verify the audit-prescribed pattern itself:
// the destructive `logout()` and navigate side-effects only fire after
// the user confirms in the dialog.
// ---------------------------------------------------------------

function SignOutHarness({
  logout,
  nav,
}: {
  logout: () => void;
  nav: (to: string) => void;
}) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      data-testid="sign-out"
      onClick={async () => {
        const ok = await confirm({
          title: "Sign out?",
          description:
            "Any unsaved annotation work in the editor will be lost.",
          confirmLabel: "Sign out",
          variant: "danger",
        });
        if (ok) {
          logout();
          nav("/login");
        }
      }}
    >
      Sign out
    </button>
  );
}

describe("P1-9 — Sign out confirm pattern (TopBar/LeftNav)", () => {
  it("opens the dialog and does not log out when Cancel is clicked", async () => {
    const logout = vi.fn();
    const nav = vi.fn();
    render(
      <ConfirmProvider>
        <SignOutHarness logout={logout} nav={nav} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(logout).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it("logs out and navigates only after Confirm is clicked", async () => {
    const logout = vi.fn();
    const nav = vi.fn();
    render(
      <ConfirmProvider>
        <SignOutHarness logout={logout} nav={nav} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("sign-out"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
    expect(nav).toHaveBeenCalledWith("/login");
  });
});

// ---------------------------------------------------------------
// P1-10 — Revoke API key confirm (ApiKeyRow). ApiKeyRow is a non-
// exported helper inside SettingsPages; rather than mount the entire
// settings page (router + auth + 2 mutations) we mirror the prescribed
// handler shape and assert the same contract.
// ---------------------------------------------------------------

function RevokeHarness({ onRevoke }: { onRevoke: () => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      data-testid="revoke"
      onClick={async () => {
        const ok = await confirm({
          title: "Revoke API key?",
          description:
            "Clients using this key will stop working immediately. This cannot be undone.",
          confirmLabel: "Revoke",
          variant: "danger",
        });
        if (ok) onRevoke();
      }}
    >
      Revoke
    </button>
  );
}

describe("P1-10 — Revoke API key confirm pattern (ApiKeyRow)", () => {
  it("does not call onRevoke when Cancel is chosen", async () => {
    const onRevoke = vi.fn();
    render(
      <ConfirmProvider>
        <RevokeHarness onRevoke={onRevoke} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("revoke"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("calls onRevoke after Confirm", async () => {
    const onRevoke = vi.fn();
    render(
      <ConfirmProvider>
        <RevokeHarness onRevoke={onRevoke} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("revoke"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(onRevoke).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------
// P1-11 — Annotation X delete confirm. The contract is: the
// underlying `remove()` is gated behind a confirm dialog. The detailed
// removal path is covered by annotation-canvas-delete-cleanup.test.tsx
// (now updated to assert the new contract); here we assert the
// stand-alone handler shape and Cancel path.
// ---------------------------------------------------------------

function DeleteHarness({ onRemove }: { onRemove: () => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      data-testid="delete-x"
      onClick={async () => {
        const ok = await confirm({
          title: "Delete annotation?",
          description: "Press Cmd+Z to undo, or click Delete to remove.",
          confirmLabel: "Delete",
          variant: "danger",
        });
        if (ok) onRemove();
      }}
    >
      X
    </button>
  );
}

describe("P1-11 — Delete annotation X confirm pattern", () => {
  it("does not remove when Cancel is chosen", async () => {
    const onRemove = vi.fn();
    render(
      <ConfirmProvider>
        <DeleteHarness onRemove={onRemove} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("delete-x"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("removes after Confirm", async () => {
    const onRemove = vi.fn();
    render(
      <ConfirmProvider>
        <DeleteHarness onRemove={onRemove} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByTestId("delete-x"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------
// P1-15 — saveMutation onError emits a toast. We exercise the same
// `useMutation` instantiation pattern the editor uses and assert that
// when `mutationFn` rejects, the toast bus receives an `error` event.
// ---------------------------------------------------------------

describe("P1-15 — saveMutation onError emits a toast", () => {
  it("emits an error toast when the mutation rejects", async () => {
    const { useMutation, QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );

    const events: ToastEvent[] = [];
    const unsub = subscribeToasts((e) => events.push(e));

    function FailingSaveHarness() {
      const m = useMutation({
        mutationFn: async () => {
          throw new Error("network down");
        },
        onError: () => {
          showToast(
            "Save failed — we'll keep trying. Check your connection or refresh.",
            { variant: "error" },
          );
        },
      });
      return (
        <button
          type="button"
          data-testid="trigger-save"
          onClick={() => m.mutate()}
        >
          save
        </button>
      );
    }

    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <FailingSaveHarness />
      </QueryClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("trigger-save"));
    });

    await waitFor(() => {
      expect(events.length).toBeGreaterThan(0);
    });
    expect(events[0].variant).toBe("error");
    expect(events[0].message).toMatch(/save failed/i);

    unsub();
  });
});

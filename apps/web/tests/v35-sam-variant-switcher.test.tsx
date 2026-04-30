/**
 * v3.5 Phase B — shared SamVariantSwitcher component tests.
 *
 * Renders both the "full" (settings page) and "compact" (editor toolbar)
 * variants in isolation and exercises:
 *   • selecting a different variant opens the confirm dialog
 *   • confirming fires modelsApi.samSetActive(variant)
 *   • a 503 from the API surfaces as an error toast
 *   • mutation pending state shows a spinner
 *
 * These tests exercise the new shared component used by both
 * EditorToolbar and ModelsSamPage. The existing v30-sam-switch.test.tsx
 * keeps integration coverage by rendering the page wrapper.
 */

import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/models/sam" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi.fn(),
    samSetActive: vi.fn(),
    // v3.5 Phase C — overlay polls /models/sam-status; default to a
    // perpetual ``loading`` state so the overlay stays open during
    // tests that exercise the switcher's loading affordances. Tests
    // that need ``ready`` can override per-test.
    samStatus: vi.fn().mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: null,
      job_id: null,
    }),
  },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

import { modelsApi } from "@/api/phase2";
import { SamVariantSwitcher } from "@/components/annotation/SamVariantSwitcher";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  showToastMock.mockClear();
  (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
    active: "sam2.1-tiny",
    available: ["sam2.1-tiny", "sam2.1-small", "sam2.1-large"],
    reachable: true,
  });
});

describe("SamVariantSwitcher — full variant", () => {
  it("opens the confirm dialog and switches when the user confirms", async () => {
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active_variant: "sam2.1-small",
    });

    render(wrap(<SamVariantSwitcher variant="full" />));

    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);

    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    expect(
      screen.getByText(/Switch to .*Small/i),
    ).toBeInTheDocument();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(modelsApi.samSetActive).toHaveBeenCalledWith("sam2.1-small");
    });
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.stringContaining("sam2.1-small"),
        expect.objectContaining({ variant: "success" }),
      );
    });
  });

  it("does not call samSetActive when the user cancels", async () => {
    render(wrap(<SamVariantSwitcher variant="full" />));

    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    const cancelBtn = await screen.findByTestId("confirm-dialog-cancel");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog-confirm")).toBeNull();
    });
    expect(modelsApi.samSetActive).not.toHaveBeenCalled();
  });

  it("surfaces an error toast when the switch API fails", async () => {
    const err = Object.assign(new Error("503"), {
      response: { status: 503, data: { detail: "model_service_unavailable" } },
    });
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    render(wrap(<SamVariantSwitcher variant="full" />));
    const large = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-large",
    );
    fireEvent.click(large);
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        "Failed to switch SAM variant",
        expect.objectContaining({ variant: "error" }),
      );
    });
  });

  it("shows a spinner while the switch mutation is pending", async () => {
    // Hold the switch promise open so the pending state stays visible.
    let resolveSwitch: (v: {
      active_variant: string;
      variant: string;
      job_id: string;
      state: string;
    }) => void = () => {};
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        }),
    );

    render(wrap(<SamVariantSwitcher variant="full" />));
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(confirmBtn);

    // The status region with the spinner appears once the mutation
    // is in flight.
    await screen.findByTestId("sam-switching-status");

    // Resolve the mutation so the test cleans up cleanly.
    resolveSwitch({
      active_variant: "sam2.1-small",
      variant: "sam2.1-small",
      job_id: "abc",
      state: "loading",
    });
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalled();
    });
  });

  it("renders the ModelLoadingOverlay once a switch is confirmed", async () => {
    // The 202 response resolves immediately; the overlay then polls
    // /models/sam-status (mocked to ``loading``) so it stays mounted.
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active_variant: "sam2.1-small",
      variant: "sam2.1-small",
      job_id: "abc",
      state: "loading",
    });

    render(wrap(<SamVariantSwitcher variant="full" />));
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(confirmBtn);

    await screen.findByTestId("model-loading-overlay");
  });
});

describe("SamVariantSwitcher — compact variant", () => {
  it("renders one row per available variant with the active one marked", async () => {
    render(wrap(<SamVariantSwitcher variant="compact" />));
    const tiny = await screen.findByTestId("sam-variant-sam2.1-tiny");
    const small = await screen.findByTestId("sam-variant-sam2.1-small");
    expect(tiny.getAttribute("data-active")).toBe("true");
    expect(small.getAttribute("data-active")).toBeNull();
  });

  it("opens the confirm dialog and switches on click", async () => {
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active_variant: "sam2.1-small",
    });

    render(wrap(<SamVariantSwitcher variant="compact" />));
    const small = await screen.findByTestId("sam-variant-sam2.1-small");
    fireEvent.click(small);

    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    expect(
      screen.getByText(/Switch to .*Small/i),
    ).toBeInTheDocument();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(modelsApi.samSetActive).toHaveBeenCalledWith("sam2.1-small");
    });
  });

  it("does not call samSetActive when the user cancels", async () => {
    render(wrap(<SamVariantSwitcher variant="compact" />));
    const small = await screen.findByTestId("sam-variant-sam2.1-small");
    fireEvent.click(small);
    const cancelBtn = await screen.findByTestId("confirm-dialog-cancel");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog-confirm")).toBeNull();
    });
    expect(modelsApi.samSetActive).not.toHaveBeenCalled();
  });

  it("renders the unreachable banner when the model service is down", async () => {
    (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: "",
      available: [],
      reachable: false,
    });

    render(wrap(<SamVariantSwitcher variant="compact" />));
    await screen.findByTestId("sam-picker-unreachable-banner");
  });

  it("shows a per-row spinner while the switch is pending", async () => {
    let resolveSwitch: (v: { active_variant: string }) => void = () => {};
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        }),
    );

    render(wrap(<SamVariantSwitcher variant="compact" />));
    const small = await screen.findByTestId("sam-variant-sam2.1-small");
    fireEvent.click(small);
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    fireEvent.click(confirmBtn);

    await screen.findByTestId("sam-variant-spinner-sam2.1-small");
    await screen.findByTestId("sam-switching-status");

    resolveSwitch({ active_variant: "sam2.1-small" });
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalled();
    });
  });
});

/**
 * v3.0 Bug 7 — SAM variant hot-swap UI tests.
 *
 * Renders ModelsSamPage with a mocked modelsApi and exercises:
 *   • selecting a different variant opens the confirm dialog
 *   • confirming fires modelsApi.samSetActive(variant)
 *   • a 503 from the API surfaces as an error toast
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

// Stub TanStack Router primitives — ModelsSamPage doesn't use them, but
// transitive imports might.
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

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "a@x.com", role: "admin" },
      accessToken: "tok",
      refreshToken: "ref",
      setSession: vi.fn(),
      setAccessToken: vi.fn(),
      clear: vi.fn(),
    }),
}));

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: vi.fn(),
    samSetActive: vi.fn(),
  },
  trashApi: { list: vi.fn(), restore: vi.fn(), hardDelete: vi.fn() },
  weightsApi: { listWorkspace: vi.fn() },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

import { modelsApi } from "@/api/phase2";
import { ModelsSamPage } from "@/pages/Phase2Pages";
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

describe("ModelsSamPage — variant hot-swap", () => {
  it("renders a radio for each available variant with the active one selected", async () => {
    render(wrap(<ModelsSamPage />));
    const tiny = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-tiny",
    );
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    expect(tiny.checked).toBe(true);
    expect(small.checked).toBe(false);
  });

  it("opens the confirm dialog when a different variant is picked", async () => {
    render(wrap(<ModelsSamPage />));
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    // ConfirmDialog renders a "Switch" button (confirmLabel)
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
    expect(confirmBtn).toBeInTheDocument();
    expect(
      screen.getByText(/Switch to .*Small/i),
    ).toBeInTheDocument();
  });

  it("calls samSetActive with the picked variant after confirm", async () => {
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockResolvedValue({
      active_variant: "sam2.1-small",
    });

    render(wrap(<ModelsSamPage />));
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    const confirmBtn = await screen.findByTestId("confirm-dialog-confirm");
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
    render(wrap(<ModelsSamPage />));
    const small = await screen.findByTestId<HTMLInputElement>(
      "sam-variant-radio-sam2.1-small",
    );
    fireEvent.click(small);
    const cancelBtn = await screen.findByTestId("confirm-dialog-cancel");
    fireEvent.click(cancelBtn);

    // Wait a tick for the dialog to close
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog-confirm")).toBeNull();
    });
    expect(modelsApi.samSetActive).not.toHaveBeenCalled();
  });

  it("shows an error toast when the API returns 503", async () => {
    const err = Object.assign(new Error("503"), {
      response: { status: 503, data: { detail: "model_service_unavailable" } },
    });
    (modelsApi.samSetActive as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    render(wrap(<ModelsSamPage />));
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
});

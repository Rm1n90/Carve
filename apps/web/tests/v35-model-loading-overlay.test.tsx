/**
 * v3.5 Phase C — ModelLoadingOverlay component tests.
 *
 * Exercises the polling lifecycle directly:
 *   - opens & polls /models/sam-status while ``open`` is true
 *   - shows an indeterminate progress bar when no byte-progress
 *   - shows a determinate bar when progress_bytes/total are present
 *   - calls onClose when the state machine transitions to ``ready``
 *   - calls onError + onClose when the state machine transitions to ``error``
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

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samStatus: vi.fn(),
  },
}));

import { modelsApi } from "@/api/phase2";
import { ModelLoadingOverlay } from "@/components/annotation/ModelLoadingOverlay";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ModelLoadingOverlay", () => {
  it("renders nothing when closed", () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: null,
      job_id: null,
    });

    const onClose = vi.fn();
    render(wrap(<ModelLoadingOverlay open={false} onClose={onClose} />));
    expect(screen.queryByTestId("model-loading-overlay")).toBeNull();
    expect(modelsApi.samStatus).not.toHaveBeenCalled();
  });

  it("renders the indeterminate bar while state=loading without byte progress", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: null,
      job_id: "abc",
    });

    const onClose = vi.fn();
    render(wrap(<ModelLoadingOverlay open={true} onClose={onClose} />));

    await screen.findByTestId("model-loading-overlay");
    await screen.findByTestId("model-loading-bar-indeterminate");
    expect(
      screen.queryByTestId("model-loading-bar-determinate"),
    ).toBeNull();
    expect(
      screen.getByTestId("model-loading-subtitle").textContent,
    ).toContain("Initialising");
  });

  it("renders the determinate bar when progress_bytes/total are present", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: 1_200_000_000,
      progress_total: 2_400_000_000,
      loaded_at: null,
      error: null,
      job_id: "abc",
    });

    const onClose = vi.fn();
    render(wrap(<ModelLoadingOverlay open={true} onClose={onClose} />));

    await screen.findByTestId("model-loading-bar-determinate");
    expect(
      screen.queryByTestId("model-loading-bar-indeterminate"),
    ).toBeNull();
    const subtitle = screen.getByTestId("model-loading-subtitle");
    expect(subtitle.textContent).toMatch(/Downloading.*1\.2 GB.*2\.4 GB/);
  });

  it("calls onClose when the state machine transitions to ``ready``", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "ready",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: "2026-04-30T12:34:56+00:00",
      error: null,
      job_id: null,
    });

    const onClose = vi.fn();
    render(wrap(<ModelLoadingOverlay open={true} onClose={onClose} />));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("calls onError + onClose when the state machine transitions to ``error``", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "error",
      variant: null,
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: "model_service_unreachable",
      job_id: null,
    });

    const onClose = vi.fn();
    const onError = vi.fn();
    render(
      wrap(
        <ModelLoadingOverlay
          open={true}
          onClose={onClose}
          onError={onError}
        />,
      ),
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith("model_service_unreachable");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("uses variantHint for the title when provided", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: null,
      job_id: null,
    });

    render(
      wrap(
        <ModelLoadingOverlay
          open={true}
          onClose={vi.fn()}
          variantHint="sam2.1-small"
        />,
      ),
    );

    const title = await screen.findByTestId("model-loading-title");
    expect(title.textContent).toContain("Switching to sam2.1-small");
  });

  it("dismisses when the user clicks the cancel button", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "loading",
      variant: "sam2.1-large",
      progress_bytes: null,
      progress_total: null,
      loaded_at: null,
      error: null,
      job_id: null,
    });

    const onClose = vi.fn();
    render(wrap(<ModelLoadingOverlay open={true} onClose={onClose} />));

    const cancelBtn = await screen.findByTestId("model-loading-cancel");
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalled();
  });
});

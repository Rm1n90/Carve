// Armin Mehri — mehri.armin@gmail.com
//
// System page "Free memory" button — the comprehensive clear-the-RAM action.
// Verifies it calls systemApi.freeMemory and toasts the reclaimed RAM + VRAM
// (and a sensible "nothing was loaded" message when there was nothing to free).
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/system", () => ({
  systemApi: {
    info: vi.fn(),
    unloadModels: vi.fn(),
    freeMemory: vi.fn(),
  },
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { systemApi } from "@/api/system";
import { showToast } from "@/lib/toast";
import { SystemPage } from "@/pages/SystemPage";

const MB = 1024 * 1024;
const GB = MB * 1024;

const fakeInfo = {
  os: {
    name: "Linux",
    distro: "Ubuntu",
    hostname: "host",
    architecture: "x86_64",
    python_version: "3.12",
    uptime_seconds: 1000,
  },
  cpu: {
    model: "Test CPU",
    physical_cores: 4,
    logical_cores: 8,
    frequency_mhz_current: 3000,
    frequency_mhz_min: 800,
    frequency_mhz_max: 4000,
    load_percent: 12,
    per_core_percent: [10, 20, 30, 40, 10, 20, 30, 40],
  },
  memory: {
    total_bytes: 16 * GB,
    available_bytes: 8 * GB,
    used_bytes: 8 * GB,
    free_bytes: 6 * GB,
    percent: 50,
    swap_total_bytes: 0,
    swap_used_bytes: 0,
    swap_percent: 0,
  },
  disks: [],
  gpus: [],
  collected_at: "2026-06-05T12:00:00+00:00",
};

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  (systemApi.info as ReturnType<typeof vi.fn>).mockResolvedValue(fakeInfo);
});

describe("SystemPage — Free memory button", () => {
  it("calls freeMemory and toasts the reclaimed RAM + VRAM", async () => {
    (systemApi.freeMemory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ram_freed_mb: 2048,
      ram_available_before_mb: 6000,
      ram_available_after_mb: 8048,
      ram_total_mb: 16000,
      ram_percent_after: 40,
      vram_freed_mb: 1024,
      models_evicted: ["sam:image", "fo1"],
      malloc_trimmed: true,
    });

    const { getByTestId } = render(wrap(<SystemPage />));
    const btn = await waitFor(() => getByTestId("system-free-memory"));
    fireEvent.click(btn);

    await waitFor(() =>
      expect(systemApi.freeMemory).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const msg = (showToast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("Freed");
    expect(msg).toContain("RAM");
    expect(msg).toContain("VRAM");
  });

  it("toasts a 'nothing was loaded' message when nothing was freed", async () => {
    (systemApi.freeMemory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ram_freed_mb: 0,
      ram_available_before_mb: 8000,
      ram_available_after_mb: 8000,
      ram_total_mb: 16000,
      ram_percent_after: 50,
      vram_freed_mb: null,
      models_evicted: [],
      malloc_trimmed: true,
    });

    const { getByTestId } = render(wrap(<SystemPage />));
    const btn = await waitFor(() => getByTestId("system-free-memory"));
    fireEvent.click(btn);

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const msg = (showToast as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg.toLowerCase()).toContain("nothing was loaded");
  });
});

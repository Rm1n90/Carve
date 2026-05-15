/**
 * SamSwitchWatcher — variant-match guard.
 *
 * The watcher polls /models/sam-status during a variant switch and
 * fires a "SAM <variant> ready" toast on the loading→ready transition.
 * Two guards must be respected:
 *
 *   1. ``sawNonReady`` — at least one non-ready observation must occur
 *      before "ready" is treated as ours. Prevents firing on a stale
 *      first-poll that lands during the brief 202-return / worker-spawn
 *      race window.
 *
 *   2. Variant match — when /sam/status reports state=ready but for the
 *      OLD variant (the worker hasn't started yet), the watcher must
 *      NOT fire its toast. Without this guard the user sees "SAM
 *      <old> ready" the instant they click switch — exactly the false
 *      ready signal Armin reported when SAM 2.1 → SAM 3.1 produced a
 *      premature toast and a click that failed because the model was
 *      still loading.
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
  act,
  cleanup,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let statusQueue: Array<{
  state: string;
  variant: string | null;
  error?: string | null;
}> = [];

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samStatus: vi.fn(async () => {
      const next = statusQueue.shift();
      return (
        next ?? {
          state: "ready",
          variant: "sam3.1",
          progress_bytes: null,
          progress_total: null,
          loaded_at: null,
          error: null,
          job_id: null,
        }
      );
    }),
  },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

import { SamSwitchWatcher } from "@/components/annotation/SamSwitchWatcher";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  showToastMock.mockClear();
  statusQueue = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function tickPolls(times: number): Promise<void> {
  // Watcher polls every 1500 ms. Advance fake timers + flush microtasks.
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
  }
}

describe("SamSwitchWatcher variant-match guard", () => {
  it("does not fire ready toast when state=ready but variant doesn't match target", async () => {
    // Race window: /sam/status still reports the OLD variant as ready
    // (worker thread hasn't flipped state to loading yet). Watcher must
    // NOT treat this as the user's switch completing.
    statusQueue = [
      { state: "ready", variant: "sam2.1-large", error: null },
      { state: "ready", variant: "sam2.1-large", error: null },
      { state: "ready", variant: "sam2.1-large", error: null },
    ];

    render(wrap(<SamSwitchWatcher />));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-switching", {
          detail: { variant: "sam3.1" },
        }),
      );
    });

    await tickPolls(3);

    // No "ready" toast — variant didn't match.
    const readyToasts = showToastMock.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && /ready/i.test(call[0] as string),
    );
    expect(readyToasts).toHaveLength(0);
  });

  it("fires ready toast only when state=ready AND variant matches the target", async () => {
    // Realistic path: old-ready → loading → ready-new. Toast fires on
    // the FINAL ready with matching variant only.
    statusQueue = [
      { state: "ready", variant: "sam2.1-large", error: null },
      { state: "loading", variant: "sam3.1", error: null },
      { state: "ready", variant: "sam3.1", error: null },
    ];

    render(wrap(<SamSwitchWatcher />));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-switching", {
          detail: { variant: "sam3.1" },
        }),
      );
    });

    await tickPolls(5);

    const readyToasts = showToastMock.mock.calls.filter(
      (call) =>
        typeof call[0] === "string"
        && /sam sam3\.1 ready/i.test(call[0] as string),
    );
    expect(readyToasts.length).toBeGreaterThanOrEqual(1);
  });

  it("still requires sawNonReady — does not fire on first-poll ready of matching variant", async () => {
    // Edge: if the worker thread completed the load before the watcher's
    // first poll lands, /sam/status returns ready+target_variant
    // immediately. The sawNonReady guard prevents firing without
    // observing a loading transition — this matches the existing
    // contract and is preserved by the variant-match change.
    statusQueue = [
      { state: "ready", variant: "sam3.1", error: null },
      { state: "ready", variant: "sam3.1", error: null },
    ];

    render(wrap(<SamSwitchWatcher />));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("carve:sam-variant-switching", {
          detail: { variant: "sam3.1" },
        }),
      );
    });

    await tickPolls(3);

    const readyToasts = showToastMock.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && /ready/i.test(call[0] as string),
    );
    expect(readyToasts).toHaveLength(0);
  });
});

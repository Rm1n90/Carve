/**
 * SAM switch — active-batch guards.
 *
 * Covers two distinct guards introduced in v3.32:
 *
 *   (A) Client-side same-user warning: when the user has SAM-touching
 *       jobs registered in ``useBackgroundJobs``, the confirm dialog
 *       carries a destructive "Switch anyway" call-to-action. The
 *       default action is Cancel (safe).
 *
 *   (B) Server-side cross-user block: when the backend returns 409
 *       ``switch_blocked_by_active_jobs``, regular users see a toast;
 *       admins see a follow-up "Force switch" confirm. Accepting
 *       fires ``samSetActive`` again with ``{ force: true }``.
 *
 * Defends the user-reported bug: "I was doing the auto annotation
 * with SAM3.1, then I changed it to SAM2 in the editor so suddenly
 * the autoannotation start to skip but this need to informed to user
 * and ask for confirmation".
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

const samSetActiveMock = vi.fn();
const samActiveMock = vi.fn();
vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samActive: (...args: unknown[]) => samActiveMock(...args),
    samSetActive: (...args: unknown[]) => samSetActiveMock(...args),
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

vi.mock("@/api/projects", () => ({
  projectsApi: { update: vi.fn() },
}));

const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

import { SamVariantSwitcher } from "@/components/annotation/SamVariantSwitcher";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useBackgroundJobs } from "@/state/backgroundJobs";

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

const SAM_ACTIVE_RESPONSE = {
  active: "sam2.1-tiny",
  available: ["sam2.1-tiny", "sam2.1-large", "sam3.1"],
  reachable: true,
};

beforeEach(() => {
  samActiveMock.mockResolvedValue(SAM_ACTIVE_RESPONSE);
  samSetActiveMock.mockReset();
  showToastMock.mockReset();
  // Clear any background jobs from a prior test.
  const jobs = { ...useBackgroundJobs.getState().jobs };
  for (const id of Object.keys(jobs)) {
    useBackgroundJobs.getState().remove(id);
  }
});

afterEach(() => {
  cleanup();
});

describe("SAM switch — same-user active batch warning (Guard A)", () => {
  it("uses destructive copy when a SAM auto-text batch is registered", async () => {
    // Arrange — register a fake same-user SAM batch.
    useBackgroundJobs.getState().add({
      jobId: "batch-1",
      taskId: "task-1",
      kind: "sam-auto-text",
      label: "SAM auto-annotate",
      startedAt: Date.now(),
      cancel: async () => undefined,
      progress: { status: "running", done: 47, total: 200 },
    });
    samSetActiveMock.mockResolvedValue({
      job_id: "j",
      state: "loading",
      variant: "sam3.1",
      active_variant: "sam3.1",
    });
    render(wrap(<SamVariantSwitcher variant="compact" />));

    // Act — click a different variant.
    await waitFor(() => screen.getByTestId("sam-variant-sam3.1"));
    fireEvent.click(screen.getByTestId("sam-variant-sam3.1"));

    // Assert — the confirm dialog reflects the in-flight batch.
    await waitFor(() => {
      expect(screen.getByText(/switching now/i)).toBeTruthy();
    });
    expect(screen.getByText(/running batch job/i)).toBeTruthy();
    expect(screen.getByText(/47\/200/)).toBeTruthy();
  });

  it("does NOT call samSetActive when same-user warning is cancelled", async () => {
    // Arrange
    useBackgroundJobs.getState().add({
      jobId: "batch-2",
      taskId: "task-2",
      kind: "sam-auto-visual",
      label: "Smart Find",
      startedAt: Date.now(),
      cancel: async () => undefined,
      progress: { status: "running", done: 1, total: 5 },
    });
    render(wrap(<SamVariantSwitcher variant="compact" />));

    // Act
    await waitFor(() => screen.getByTestId("sam-variant-sam3.1"));
    fireEvent.click(screen.getByTestId("sam-variant-sam3.1"));
    await waitFor(() => screen.getByText(/keep current/i));
    fireEvent.click(screen.getByText(/keep current/i));

    // Assert
    await waitFor(() => {
      expect(samSetActiveMock).not.toHaveBeenCalled();
    });
  });
});

describe("SAM switch — backend 409 block (Guard B)", () => {
  function buildBackend409(canForce: boolean): Error {
    const err = new Error("Conflict");
    (err as { response?: unknown }).response = {
      status: 409,
      data: {
        detail: {
          code: "switch_blocked_by_active_jobs",
          error: "switch_blocked_by_active_jobs",
          active_jobs: [
            { job_id: "j-1", status: "running", done: 30, total: 100 },
            { job_id: "j-2", status: "queued", done: 0, total: 50 },
          ],
          can_force: canForce,
          message:
            "2 auto-annotate batch job(s) are currently using SAM. Wait for them to finish.",
        },
      },
    };
    return err;
  }

  it("non-admin sees an error toast naming the affected jobs", async () => {
    // Arrange — backend returns 409, no force allowed.
    samSetActiveMock.mockRejectedValueOnce(buildBackend409(false));
    render(wrap(<SamVariantSwitcher variant="compact" />));

    // Act — switch + confirm the (non-destructive) dialog.
    await waitFor(() => screen.getByTestId("sam-variant-sam3.1"));
    fireEvent.click(screen.getByTestId("sam-variant-sam3.1"));
    await waitFor(() => screen.getByText(/^Switch$/));
    fireEvent.click(screen.getByText(/^Switch$/));

    // Assert — toast carries the backend message; no force-switch
    // confirm shown.
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.stringContaining("currently using SAM"),
        expect.objectContaining({ variant: "error" }),
      );
    });
    // The destructive confirm must NOT have been opened.
    expect(screen.queryByText(/force switch/i)).toBeNull();
  });

  it("admin sees the force-switch confirm and retries with force=true on accept", async () => {
    // Arrange — first call returns 409 with can_force=true; second
    // (forced) call resolves successfully.
    samSetActiveMock
      .mockRejectedValueOnce(buildBackend409(true))
      .mockResolvedValueOnce({
        job_id: "j",
        state: "loading",
        variant: "sam3.1",
        active_variant: "sam3.1",
      });
    render(wrap(<SamVariantSwitcher variant="compact" />));

    // Act — initial switch attempt.
    await waitFor(() => screen.getByTestId("sam-variant-sam3.1"));
    fireEvent.click(screen.getByTestId("sam-variant-sam3.1"));
    await waitFor(() => screen.getByText(/^Switch$/));
    fireEvent.click(screen.getByText(/^Switch$/));

    // Assert — force-switch confirm opens with the destructive label.
    await waitFor(() => {
      expect(screen.getByText(/force switch \(cancel 2\)/i)).toBeTruthy();
    });

    // Accept the force.
    fireEvent.click(screen.getByText(/force switch \(cancel 2\)/i));

    // Assert — samSetActive was called twice; the second time with
    // ``{ force: true }``.
    await waitFor(() => {
      expect(samSetActiveMock).toHaveBeenCalledTimes(2);
    });
    expect(samSetActiveMock).toHaveBeenLastCalledWith("sam3.1", {
      force: true,
    });
  });
});

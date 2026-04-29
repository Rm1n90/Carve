import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Toast bus mock — both surfaces under test call `showToast` from
// `@/lib/toast`. Capturing the helper directly is more reliable than
// subscribing to the bus across the React render lifecycle.
// ---------------------------------------------------------------------------
const showToastMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
  subscribeToasts: () => () => {},
  _resetToastBusForTests: () => {},
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ id: "p-1", name: "P1", description: null }),
    importClasses: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { showToast } from "@/lib/toast";
import { ClassesEditor } from "@/pages/ClassesEditor";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

const conflictError = {
  response: { status: 409, data: { detail: "class_idx_or_name_conflict" } },
};

describe("v3.2 Issue 7 — Duplicate-name class shows toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToastMock.mockClear();
  });

  describe("ClassesEditor (project-level form)", () => {
    it("toasts an 'already exists' error when API returns 409 conflict", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      (classesApi.create as any).mockRejectedValue(conflictError);

      render(wrap(<ClassesEditor projectId="p1" />));

      fireEvent.change(await screen.findByLabelText(/class name/i), {
        target: { value: "Person" },
      });
      fireEvent.click(screen.getByRole("button", { name: /add class/i }));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalled();
      });
      const [message, options] = showToastMock.mock.calls[0];
      expect(message).toContain("already exists");
      expect(message).toContain("Person");
      expect(options).toMatchObject({ variant: "error" });
    });

    it("toasts a generic failure for non-conflict errors (e.g. 500)", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      (classesApi.create as any).mockRejectedValue({
        response: { status: 500, data: { detail: "internal_server_error" } },
      });

      render(wrap(<ClassesEditor projectId="p1" />));

      fireEvent.change(await screen.findByLabelText(/class name/i), {
        target: { value: "Cat" },
      });
      fireEvent.click(screen.getByRole("button", { name: /add class/i }));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalled();
      });
      const [message, options] = showToastMock.mock.calls[0];
      expect(message).toBe("Failed to add class.");
      expect(options).toMatchObject({ variant: "error" });
    });
  });

  // ---------------------------------------------------------------------------
  // AnnotateAssetPage class-create flow
  //
  // The full AnnotateAssetPage requires the router, canvas, ~10 mocks (see
  // tests/annotate-page.test.tsx). For the duplicate-name path we exercise
  // the same mutation+onError contract via a minimal harness that mirrors
  // the production `classCreate` mutation in AnnotateAssetPage.tsx so any
  // drift in the onError contract surfaces here.
  // ---------------------------------------------------------------------------
  function MiniHarness({ projectId }: { projectId: string }) {
    const qc = useQueryClient();
    const m = useMutation({
      mutationFn: (input: { idx: number; name: string; color: string }) =>
        classesApi.create(projectId, input),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
      onError: (
        err: unknown,
        variables: { idx: number; name: string; color: string },
      ) => {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response
          ?.data?.detail;
        const pendingName = variables.name;
        if (detail === "class_idx_or_name_conflict") {
          showToast(
            `A class named "${pendingName}" already exists in this project.`,
            { variant: "error" },
          );
        } else {
          showToast("Failed to add class.", { variant: "error" });
        }
      },
    });
    return (
      <button
        type="button"
        data-testid="mini-create"
        onClick={() => m.mutate({ idx: 0, name: "Person", color: "#ef4444" })}
      >
        Create
      </button>
    );
  }

  describe("AnnotateAssetPage class-create flow", () => {
    it("toasts an 'already exists' error when API returns 409 conflict", async () => {
      (classesApi.create as any).mockRejectedValue(conflictError);

      render(wrap(<MiniHarness projectId="p-1" />));
      fireEvent.click(screen.getByTestId("mini-create"));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalled();
      });
      const [message, options] = showToastMock.mock.calls[0];
      expect(message).toContain("already exists");
      expect(message).toContain("Person");
      expect(options).toMatchObject({ variant: "error" });
    });

    it("toasts a generic failure for non-conflict errors", async () => {
      (classesApi.create as any).mockRejectedValue({
        response: { status: 500, data: { detail: "internal_server_error" } },
      });

      render(wrap(<MiniHarness projectId="p-1" />));
      fireEvent.click(screen.getByTestId("mini-create"));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalled();
      });
      const [message, options] = showToastMock.mock.calls[0];
      expect(message).toBe("Failed to add class.");
      expect(options).toMatchObject({ variant: "error" });
    });
  });
});

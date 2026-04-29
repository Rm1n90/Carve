/**
 * v3.0 D12 — "Single set (no split)" toggle in the Export dialog.
 *
 * The split inputs only matter for train/val/test datasets; for projects that
 * just want to ship every annotation as one set, we should not force the user
 * to manually type 1.0 / 0 / 0. The backend already accepts that shape — this
 * test pins the frontend contract.
 */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/exports", () => ({
  exportsApi: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
  },
}));

import { exportsApi } from "@/api/exports";
import { classesApi } from "@/api/classes";
import { ExportDialog } from "@/pages/ExportDialog";

const mockClasses = [
  {
    id: "c1",
    project_id: "p1",
    idx: 0,
    name: "car",
    color: "#f00",
    attributes: {},
    created_at: "",
  },
];

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ExportDialog — no-split toggle (v3.0 D12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (classesApi.listForProject as any).mockResolvedValue(mockClasses);
  });

  it("defaults to single set and hides the numeric split inputs (v3.1 Bug 4)", async () => {
    // Arrange / Act
    const { findByText, getByLabelText, queryByLabelText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");

    // Assert — single set is now the default; train/val/test inputs are hidden.
    const trainValTestRadio = getByLabelText(
      "split-mode-train-val-test",
    ) as HTMLInputElement;
    const singleRadio = getByLabelText("split-mode-single") as HTMLInputElement;
    expect(singleRadio.checked).toBe(true);
    expect(trainValTestRadio.checked).toBe(false);
    expect(queryByLabelText("split-train")).toBeNull();
    expect(queryByLabelText("split-val")).toBeNull();
    expect(queryByLabelText("split-test")).toBeNull();
  });

  it("hides the numeric split inputs when 'Single set' is selected", async () => {
    // Arrange
    const { findByText, getByLabelText, queryByLabelText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");

    // Act
    fireEvent.click(getByLabelText("split-mode-single"));

    // Assert
    expect(queryByLabelText("split-train")).toBeNull();
    expect(queryByLabelText("split-val")).toBeNull();
    expect(queryByLabelText("split-test")).toBeNull();
  });

  it("submits {train: 1.0, val: 0.0, test: 0.0} when 'Single set' is selected", async () => {
    // Arrange
    (exportsApi.create as any).mockResolvedValue({ export_id: "e-single" });
    const { findByText, getByLabelText, getByRole } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");

    // Act
    fireEvent.click(getByLabelText("split-mode-single"));
    fireEvent.click(getByRole("button", { name: /export/i }));

    // Assert
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const body = (exportsApi.create as any).mock.calls[0][1];
    expect(body.splits).toEqual({ train: 1.0, val: 0.0, test: 0.0 });
  });

  it("still submits the user-chosen splits when train-val-test mode is selected", async () => {
    // Arrange
    (exportsApi.create as any).mockResolvedValue({ export_id: "e-tvt" });
    const { findByText, getByLabelText, getByRole } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");

    // Act — opt into train-val-test; defaults are 0.8 / 0.1 / 0.1.
    // v3.1 Bug 4 — single-set is the default, so the radio must be flipped
    // before submitting to exercise the train/val/test path.
    fireEvent.click(getByLabelText("split-mode-train-val-test"));
    fireEvent.click(getByRole("button", { name: /export/i }));

    // Assert
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const body = (exportsApi.create as any).mock.calls[0][1];
    expect(body.splits).toEqual({ train: 0.8, val: 0.1, test: 0.1 });
  });
});

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/imports", () => ({
  importsApi: {
    createDryrun: vi.fn(),
    confirm: vi.fn(),
    get: vi.fn(),
  },
}));

import { importsApi } from "@/api/imports";
import { ImportDialog } from "@/pages/ImportDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const baseDryrun = {
  import_id: "imp-1",
  format: "yolo" as const,
  status: "awaiting_confirmation" as const,
  report: {
    total_parsed: 5,
    importable: 5,
    by_kind: { bbox: 5 },
    matched_files: ["IMG_001.jpg"],
    unmatched_files: [],
    unknown_classes: [],
    class_names_resolved: ["person"],
    parse_warnings: [],
  },
};

describe("ImportDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls importsApi.createDryrun with format=yolo by default", async () => {
    (importsApi.createDryrun as any).mockResolvedValue(baseDryrun);
    const { container } = render(wrap(<ImportDialog taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const zip = new File([new Uint8Array([0x50, 0x4b])], "labels.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [zip] } });
    await waitFor(() => {
      expect(importsApi.createDryrun).toHaveBeenCalledWith("t1", [zip], "yolo");
    });
  });

  it("uses format=coco when user selects COCO", async () => {
    (importsApi.createDryrun as any).mockResolvedValue({
      ...baseDryrun,
      format: "coco",
    });
    const { container, findByTestId, getByLabelText } = render(
      wrap(<ImportDialog taskId="t1" />),
    );
    const trigger = getByLabelText("import-format");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    const cocoItem = await findByTestId("import-format-coco");
    fireEvent.click(cocoItem);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const json = new File([new Uint8Array([0x7b, 0x7d])], "annotations.json", {
      type: "application/json",
    });
    fireEvent.change(input, { target: { files: [json] } });
    await waitFor(() => {
      expect(importsApi.createDryrun).toHaveBeenCalledWith("t1", [json], "coco");
    });
  });

  it("renders the validation report and confirms on click", async () => {
    (importsApi.createDryrun as any).mockResolvedValue({
      ...baseDryrun,
      report: {
        ...baseDryrun.report,
        unmatched_files: [{ file: "IMG_999", rows: 2 }],
        importable: 3,
        total_parsed: 5,
      },
    });
    (importsApi.confirm as any).mockResolvedValue({
      import_id: "imp-1",
      status: "running",
    });
    (importsApi.get as any).mockResolvedValue({
      status: "running",
      done: 0,
      total: 3,
      warnings: [],
    });
    const { container, findByTestId } = render(wrap(<ImportDialog taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const zip = new File([new Uint8Array([0x50, 0x4b])], "labels.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [zip] } });
    const confirmBtn = await findByTestId("import-confirm");
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(importsApi.confirm).toHaveBeenCalledWith("t1", "imp-1");
    });
  });
});

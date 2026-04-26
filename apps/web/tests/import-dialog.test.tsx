import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/imports", () => ({
  importsApi: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

import { importsApi } from "@/api/imports";
import { ImportDialog } from "@/pages/ImportDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ImportDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls importsApi.create with format=yolo by default", async () => {
    (importsApi.create as any).mockResolvedValue({ import_id: "imp-1" });
    (importsApi.get as any).mockResolvedValue({
      status: "running",
      done: 0,
      total: 1,
      warnings: [],
    });
    const { container } = render(wrap(<ImportDialog taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const zip = new File([new Uint8Array([0x50, 0x4b])], "labels.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [zip] } });
    await waitFor(() => {
      expect(importsApi.create).toHaveBeenCalledWith("t1", zip, "yolo");
    });
  });

  it("uses format=coco when user selects COCO", async () => {
    (importsApi.create as any).mockResolvedValue({ import_id: "imp-2" });
    (importsApi.get as any).mockResolvedValue({
      status: "running",
      done: 0,
      total: 1,
      warnings: [],
    });
    const { container, getByLabelText } = render(wrap(<ImportDialog taskId="t1" />));
    const select = getByLabelText("import-format") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "coco" } });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const json = new File([new Uint8Array([0x7b, 0x7d])], "annotations.json", {
      type: "application/json",
    });
    fireEvent.change(input, { target: { files: [json] } });
    await waitFor(() => {
      expect(importsApi.create).toHaveBeenCalledWith("t1", json, "coco");
    });
  });

  it("polls progress and stops when status=completed", async () => {
    (importsApi.create as any).mockResolvedValue({ import_id: "imp-1" });
    (importsApi.get as any).mockResolvedValue({
      status: "completed",
      done: 5,
      total: 5,
      warnings: ["missing-class:dog"],
    });
    const { container, findByText } = render(wrap(<ImportDialog taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const zip = new File([new Uint8Array([0x50, 0x4b])], "labels.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [zip] } });

    await waitFor(() => {
      expect(importsApi.get).toHaveBeenCalledWith("t1", "imp-1");
    });
    await findByText(/missing-class:dog/);
    await findByText(/^Done\.$/);
  });

  it("treats status=completed_with_warnings as terminal+success", async () => {
    (importsApi.create as any).mockResolvedValue({ import_id: "imp-3" });
    (importsApi.get as any).mockResolvedValue({
      status: "completed_with_warnings",
      done: 3,
      total: 5,
      warnings: ["missing-asset:foo"],
    });
    const { container, findByText } = render(wrap(<ImportDialog taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const zip = new File([new Uint8Array([0x50, 0x4b])], "labels.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [zip] } });

    await waitFor(() => {
      expect(importsApi.get).toHaveBeenCalledWith("t1", "imp-3");
    });
    await findByText(/missing-asset:foo/);
    await findByText(/^Done\.$/);
  });
});

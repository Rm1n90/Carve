import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/assets", () => ({
  assetsApi: {
    listForTask: vi.fn(),
    upload: vi.fn(),
    uploadZip: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

import { assetsApi } from "@/api/assets";
import { AssetUploadDialog } from "@/pages/AssetUploadDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("AssetUploadDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls assetsApi.upload for image files", async () => {
    (assetsApi.upload as any).mockResolvedValue({});
    const { container } = render(wrap(<AssetUploadDialog projectId="p1" taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(assetsApi.upload).toHaveBeenCalledWith("t1", file);
    });
  });

  it("calls assetsApi.uploadZip for .zip files", async () => {
    (assetsApi.uploadZip as any).mockResolvedValue([]);
    const { container } = render(wrap(<AssetUploadDialog projectId="p1" taskId="t1" />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const zip = new File([new Uint8Array([0x50, 0x4b])], "imgs.zip", { type: "application/zip" });
    fireEvent.change(input, { target: { files: [zip] } });
    await waitFor(() => {
      expect(assetsApi.uploadZip).toHaveBeenCalledWith("t1", zip);
    });
  });
});

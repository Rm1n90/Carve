import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
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

  describe("v2.6: 429 retry behavior", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries after Retry-After window when API returns 429, then succeeds", async () => {
      // Arrange: first call rejects with a 429, second resolves cleanly.
      const rateLimitErr = {
        response: {
          status: 429,
          data: { error: "rate_limited", retry_after_seconds: 2 },
          headers: { "retry-after": "2" },
        },
      };
      (assetsApi.upload as any)
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValueOnce({ id: "asset-1" });

      vi.useFakeTimers({ shouldAdvanceTime: true });

      const { container, findByRole } = render(
        wrap(<AssetUploadDialog projectId="p1" taskId="t1" />),
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });

      // Act: drop the file → first attempt 429s, dialog shows retry notice.
      fireEvent.change(input, { target: { files: [file] } });

      const notice = await findByRole("status");
      expect(notice.textContent).toMatch(/server busy/i);
      expect(notice.textContent).toMatch(/2 seconds/);
      expect(assetsApi.upload).toHaveBeenCalledTimes(1);

      // Act: advance past the Retry-After window so the retry fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });

      // Assert: retry was issued, succeeded, no error row was added.
      await waitFor(() => {
        expect(assetsApi.upload).toHaveBeenCalledTimes(2);
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it("gives up after 3 retries on persistent 429 and surfaces the error", async () => {
      const rateLimitErr = {
        response: {
          status: 429,
          data: { error: "rate_limited", retry_after_seconds: 1 },
          headers: { "retry-after": "1" },
        },
      };
      (assetsApi.upload as any).mockRejectedValue(rateLimitErr);

      vi.useFakeTimers({ shouldAdvanceTime: true });

      const { container, findByRole } = render(
        wrap(<AssetUploadDialog projectId="p1" taskId="t1" />),
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });
      fireEvent.change(input, { target: { files: [file] } });

      // 3 retry windows × 1.5s each lets the helper exhaust MAX_RETRIES.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_500);
        });
      }

      // 1 initial + 3 retries = 4 total calls, then the loop gives up.
      await waitFor(() => {
        expect(assetsApi.upload).toHaveBeenCalledTimes(4);
      });
      const errList = await findByRole("alert");
      expect(errList.textContent).toMatch(/rate_limited/);
    });
  });
});

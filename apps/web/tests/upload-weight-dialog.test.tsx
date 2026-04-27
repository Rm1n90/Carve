import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/phase2", () => ({
  weightsApi: {
    upload: vi.fn(),
    delete: vi.fn(),
    listWorkspace: vi.fn(),
    listForProject: vi.fn(),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi
      .fn()
      .mockResolvedValue([
        { id: "p1", name: "Project One", description: null, owner_id: "u1", created_at: "" },
        { id: "p2", name: "Project Two", description: null, owner_id: "u1", created_at: "" },
      ]),
  },
}));

import { weightsApi } from "@/api/phase2";
import { UploadWeightDialog } from "@/pages/UploadWeightDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  (weightsApi.upload as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "w1",
    project_id: "p1",
    name: "yolo",
    task_kind: "detect",
    minio_key: "weights/x.pt",
    size_bytes: 6_500_000,
    class_names: [],
    created_by: null,
    created_at: "2026-04-26T10:00:00+00:00",
  });
});

describe("UploadWeightDialog", () => {
  it("does not render content when open=false", () => {
    render(wrap(<UploadWeightDialog open={false} onOpenChange={() => undefined} />));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables submit until both file and name are present", async () => {
    render(wrap(<UploadWeightDialog open onOpenChange={() => undefined} />));
    await screen.findByText(/upload yolo weight/i);
    const submit = screen.getByRole("button", { name: /^upload$/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls weightsApi.upload with the form values and closes on success", async () => {
    const onOpenChange = vi.fn();
    render(
      wrap(<UploadWeightDialog open onOpenChange={onOpenChange} defaultProjectId="p1" />),
    );
    await screen.findByText(/upload yolo weight/i);

    // The dialog renders into a Radix portal, so query the document, not the
    // local container.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const file = new File(
      [new Uint8Array([0x80, 0x02])],
      "yolov8n.pt",
      { type: "application/octet-stream" },
    );
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Name should auto-fill from filename without extension.
    const nameInput = (await screen.findByLabelText(/^name$/i)) as HTMLInputElement;
    expect(nameInput.value).toBe("yolov8n");

    const submit = screen.getByRole("button", { name: /^upload$/i });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(weightsApi.upload).toHaveBeenCalledTimes(1);
    });
    const [pid, payload] = (weightsApi.upload as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pid).toBe("p1");
    expect(payload.name).toBe("yolov8n");
    expect(payload.task_kind).toBe("detect");
    expect(payload.class_names).toEqual([]);
    expect(payload.file).toBe(file);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

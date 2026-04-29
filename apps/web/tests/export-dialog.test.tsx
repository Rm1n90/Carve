import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/exports", () => ({
  exportsApi: {
    create: vi.fn(),
    get: vi.fn(),
  },
}));

// v3.1 Issue 3 — ExportDialog now pulls task-effective classes via
// tasksApi.getClasses (Option A subset model). The legacy classesApi
// mock is no longer used by ExportDialog but we keep a stub so any
// transitive import path resolves.
vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
  },
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    getClasses: vi.fn(),
  },
}));

import { exportsApi } from "@/api/exports";
import { tasksApi } from "@/api/tasks";
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
  {
    id: "c2",
    project_id: "p1",
    idx: 1,
    name: "truck",
    color: "#0f0",
    attributes: {},
    created_at: "",
  },
  {
    id: "c3",
    project_id: "p1",
    idx: 2,
    name: "bus",
    color: "#00f",
    attributes: {},
    created_at: "",
  },
  {
    id: "c4",
    project_id: "p1",
    idx: 3,
    name: "bike",
    color: "#ff0",
    attributes: {},
    created_at: "",
  },
  {
    id: "c5",
    project_id: "p1",
    idx: 4,
    name: "person",
    color: "#0ff",
    attributes: {},
    created_at: "",
  },
];

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe("ExportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (tasksApi.getClasses as any).mockResolvedValue({
      classes: mockClasses,
      allowed_class_ids: null,
    });
  });

  it("renders one row per project class", async () => {
    const { findByText } = render(wrap(<ExportDialog projectId="p1" taskId="t1" />));
    await findByText("car");
    await findByText("truck");
    await findByText("bus");
    await findByText("bike");
    await findByText("person");
  });

  it("submits class_remap with default mapping (idx → export_id, name unchanged)", async () => {
    (exportsApi.create as any).mockResolvedValue({ export_id: "e1" });
    const { findByText, getByLabelText, getByRole } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");
    // v3.1 Bug 4 — single-set is the default; opt into train/val/test
    // explicitly so the splits assertion below still exercises 0.8/0.1/0.1.
    fireEvent.click(getByLabelText("split-mode-train-val-test"));
    fireEvent.click(getByRole("button", { name: /export/i }));
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const [taskIdArg, body] = (exportsApi.create as any).mock.calls[0];
    expect(taskIdArg).toBe("t1");
    expect(body.format).toBe("yolo");
    expect(body.splits).toEqual({ train: 0.8, val: 0.1, test: 0.1 });
    expect(body.include_images).toBe(true);
    expect(body.class_remap).toEqual({
      c1: { export_id: 0, name: "car" },
      c2: { export_id: 1, name: "truck" },
      c3: { export_id: 2, name: "bus" },
      c4: { export_id: 3, name: "bike" },
      c5: { export_id: 4, name: "person" },
    });
  });

  it("marks a class as skipped → payload value is null", async () => {
    (exportsApi.create as any).mockResolvedValue({ export_id: "e2" });
    const { findByText, getByRole, getByLabelText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("bus");
    const skipBus = getByLabelText("skip-c3") as HTMLInputElement;
    fireEvent.click(skipBus);
    fireEvent.click(getByRole("button", { name: /export/i }));
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const body = (exportsApi.create as any).mock.calls[0][1];
    expect(body.class_remap.c3).toBeNull();
    expect(body.class_remap.c1).toEqual({ export_id: 0, name: "car" });
    expect(body.class_remap.c2).toEqual({ export_id: 1, name: "truck" });
    expect(body.class_remap.c4).toEqual({ export_id: 3, name: "bike" });
    expect(body.class_remap.c5).toEqual({ export_id: 4, name: "person" });
  });

  it("switches format to coco", async () => {
    (exportsApi.create as any).mockResolvedValue({ export_id: "e3" });
    const { findByText, findByTestId, getByRole, getByLabelText } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");
    // v3.0: Format is now a Radix Select. Open trigger then click item.
    const trigger = getByLabelText("export-format");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    const cocoItem = await findByTestId("export-format-coco");
    fireEvent.click(cocoItem);
    fireEvent.click(getByRole("button", { name: /export/i }));
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const body = (exportsApi.create as any).mock.calls[0][1];
    expect(body.format).toBe("coco");
  });

  it("shows download link when status=completed", async () => {
    (exportsApi.create as any).mockResolvedValue({ export_id: "e4" });
    (exportsApi.get as any).mockResolvedValue({
      id: "e4",
      status: "completed",
      download_url: "https://example.com/x.zip",
      error: null,
      completed_at: "2025-01-01T00:00:00Z",
    });
    const { findByText, findByRole, getByRole } = render(
      wrap(<ExportDialog projectId="p1" taskId="t1" />),
    );
    await findByText("car");
    fireEvent.click(getByRole("button", { name: /export/i }));
    await waitFor(() => {
      expect(exportsApi.create).toHaveBeenCalled();
    });
    const link = (await findByRole("link", { name: /download/i })) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/x.zip");
  });
});

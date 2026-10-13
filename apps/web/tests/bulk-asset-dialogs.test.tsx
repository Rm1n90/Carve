// Armin Mehri — mehri.armin@gmail.com
//
// Bulk delete / move of selected images: the dialogs say what will
// happen (annotations deleted, classes the target lacks, renamed or
// skipped files, a busy task) before anything is sent.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { assetsApi, type BulkPreview } from "@/api/assets";
import { tasksApi } from "@/api/tasks";
import { DeleteAssetsDialog, MoveAssetsDialog } from "@/components/assets/BulkAssetDialogs";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const ANNOTATED: BulkPreview = {
  images: 3,
  not_found: 0,
  annotated_images: 2,
  annotations: 41,
  by_class: [
    { class_id: "c1", name: "person", count: 30 },
    { class_id: "c2", name: "backdrop", count: 11 },
  ],
  busy: null,
  target: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Delete dialog", () => {
  it("warns about the annotations and needs an explicit OK", async () => {
    vi.spyOn(assetsApi, "bulkPreview").mockResolvedValue(ANNOTATED);
    const del = vi.spyOn(assetsApi, "bulkDelete").mockResolvedValue({ deleted: 3, annotations_deleted: 41 });
    const onDeleted = vi.fn();
    render(wrap(
      <DeleteAssetsDialog open onOpenChange={() => {}} taskId="t1" assetIds={["a", "b", "c"]} onDeleted={onDeleted} />,
    ));
    const warn = await screen.findByTestId("bulk-delete-annotated");
    expect(warn.textContent).toContain("2 images");
    expect(warn.textContent).toContain("41 annotations will be deleted");
    expect(warn.textContent).toContain("person");

    const confirm = screen.getByTestId("bulk-delete-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId("bulk-delete-understood"));
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    // The count the user saw goes along, so a changed selection is refused.
    await waitFor(() => expect(del).toHaveBeenCalledWith("t1", ["a", "b", "c"], 41));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ deleted: 3, annotations_deleted: 41 }));
  });

  it("says so when none is annotated", async () => {
    vi.spyOn(assetsApi, "bulkPreview").mockResolvedValue({ ...ANNOTATED, annotated_images: 0, annotations: 0, by_class: [] });
    render(wrap(<DeleteAssetsDialog open onOpenChange={() => {}} taskId="t1" assetIds={["a"]} onDeleted={() => {}} />));
    expect(await screen.findByTestId("bulk-delete-clean")).toBeTruthy();
  });

  it("is blocked while a Logo AI run works on the task", async () => {
    vi.spyOn(assetsApi, "bulkPreview").mockResolvedValue({ ...ANNOTATED, busy: "logo_ai_running" });
    render(wrap(<DeleteAssetsDialog open onOpenChange={() => {}} taskId="t1" assetIds={["a"]} onDeleted={() => {}} />));
    expect((await screen.findByTestId("bulk-busy")).textContent).toContain("Logo AI run");
    fireEvent.click(screen.getByTestId("bulk-delete-understood"));
    expect(screen.getByTestId("bulk-delete-confirm")).toBeDisabled();
  });
});

describe("Move dialog", () => {
  const TASKS = [
    { id: "t1", project_id: "p", name: "Set 1", kind: "image", created_at: "" },
    { id: "t2", project_id: "p", name: "Set 2", kind: "image", created_at: "" },
    { id: "t3", project_id: "p", name: "Clips", kind: "video", created_at: "" },
  ];

  function pickTarget(id: string) {
    const trigger = screen.getByTestId("bulk-move-target");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId(`bulk-move-target-${id}`));
  }

  it("lists what the move does and lets the user choose for missing classes", async () => {
    vi.spyOn(tasksApi, "listForProject").mockResolvedValue(TASKS as never);
    vi.spyOn(assetsApi, "bulkPreview").mockResolvedValue({
      ...ANNOTATED,
      target: {
        task_id: "t2",
        name: "Set 2",
        same_kind: true,
        busy: null,
        to_move: 2,
        annotations_to_move: 30,
        already_in_target: 1,
        renamed: 1,
        missing_classes: [{ class_id: "c2", name: "backdrop", count: 11 }],
      },
    });
    const mv = vi.spyOn(assetsApi, "bulkMove").mockResolvedValue({
      moved: 2, skipped_duplicates: 1, renamed: 1, annotations_moved: 19, annotations_dropped: 11, classes_enabled: 0,
    });
    const onMoved = vi.fn();
    render(wrap(
      <MoveAssetsDialog open onOpenChange={() => {}} projectId="p" taskId="t1" assetIds={["a", "b", "c"]} onMoved={onMoved} />,
    ));
    await waitFor(() => expect(screen.getByTestId("bulk-move-target")).toBeTruthy());
    pickTarget("t2");
    const summary = await screen.findByTestId("bulk-move-summary");
    expect(summary.textContent).toContain("2 images will move to Set 2 with 30 annotations");
    expect(screen.getByTestId("bulk-move-duplicates").textContent).toContain("already in Set 2");
    expect(screen.getByTestId("bulk-move-renamed").textContent).toContain("1 file name already exists");
    expect(screen.getByTestId("bulk-move-missing-classes").textContent).toContain("backdrop");

    fireEvent.click(screen.getByTestId("bulk-move-drop"));
    fireEvent.click(screen.getByTestId("bulk-move-confirm"));
    await waitFor(() =>
      expect(mv).toHaveBeenCalledWith("t1", {
        asset_ids: ["a", "b", "c"],
        target_task_id: "t2",
        missing_classes: "drop",
        skip_duplicates: true,
        annotations_expected: 41,
      }),
    );
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it("will not move into a task a job is working on", async () => {
    vi.spyOn(tasksApi, "listForProject").mockResolvedValue(TASKS as never);
    vi.spyOn(assetsApi, "bulkPreview").mockResolvedValue({
      ...ANNOTATED,
      target: {
        task_id: "t2", name: "Set 2", same_kind: true, busy: "job_running", to_move: 3,
        annotations_to_move: 41, already_in_target: 0, renamed: 0, missing_classes: [],
      },
    });
    render(wrap(
      <MoveAssetsDialog open onOpenChange={() => {}} projectId="p" taskId="t1" assetIds={["a"]} onMoved={() => {}} />,
    ));
    await waitFor(() => expect(screen.getByTestId("bulk-move-target")).toBeTruthy());
    pickTarget("t2");
    expect((await screen.findByTestId("bulk-target-busy")).textContent).toContain("Set 2");
    expect(screen.getByTestId("bulk-move-confirm")).toBeDisabled();
  });
});

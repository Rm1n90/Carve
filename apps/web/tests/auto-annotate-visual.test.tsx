// Armin Mehri — mehri.armin@gmail.com
/**
 * v3.28 — AutoAnnotateDialog SAM Visual Prompt tab.
 *
 * Asserts:
 *   - Visual tab hidden when ``visual_prompt_available !== true``
 *   - Visual tab visible when capability is on; switching shows the
 *     ref-kind toggle (bbox / polygon)
 *   - Run button disabled when no picks present
 *   - Switching ref-kind with picks present shows confirm modal
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
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";

vi.mock("@/api/sam", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/sam")>("@/api/sam");
  return {
    ...actual,
    samApi: {
      ...actual.samApi,
      autoText: vi.fn(),
      autoTextBatch: vi.fn(),
      autoTextBatchProgress: vi.fn(),
      autoTextBatchCancel: vi.fn(),
      autoVisual: vi.fn(),
      autoVisualBatch: vi.fn(),
      autoVisualBatchProgress: vi.fn(),
      autoVisualBatchCancel: vi.fn(),
    },
  };
});

vi.mock("@/api/phase2", () => ({
  modelsApi: {
    samStatus: vi.fn(),
  },
}));

vi.mock("@/api/assets", () => ({
  assetsApi: {
    listForTask: vi.fn().mockResolvedValue([
      {
        id: "a1",
        original_name: "img1.jpg",
        thumbnail_url: null,
        kind: "image",
      },
    ]),
  },
}));

vi.mock("@/api/annotations", () => ({
  annotationsApi: {
    listForTaskRaw: vi.fn().mockResolvedValue([
      {
        id: "ann-1",
        asset_id: "a1",
        frame_id: null,
        class_id: "c1",
        kind: "bbox",
        geometry: { kind: "bbox", x: 0, y: 0, w: 10, h: 10 },
        created_at: "2026-05-08T00:00:00Z",
      },
      {
        id: "ann-2",
        asset_id: "a1",
        frame_id: null,
        class_id: "c1",
        kind: "polygon",
        geometry: {
          kind: "polygon",
          points: [
            [0, 0],
            [5, 0],
            [5, 5],
          ],
        },
        created_at: "2026-05-08T00:00:00Z",
      },
    ]),
  },
}));

import { modelsApi } from "@/api/phase2";
import { AutoAnnotateDialog } from "@/components/annotation/AutoAnnotateDialog";
import { useAnnotations } from "@/state/annotations";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

const baseClasses = [
  {
    id: "c1",
    project_id: "p1",
    name: "Cat",
    color: "#f00",
    idx: 0,
    text_prompt: "a cat",
    is_active: true,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;

beforeEach(() => {
  vi.clearAllMocks();
  useAnnotations.setState({ byId: {} });
});

afterEach(() => {
  cleanup();
});

describe("AutoAnnotateDialog — SAM Visual Prompt tab", () => {
  it("hides the visual tab when visual_prompt_available !== true", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      variant: "sam3",
      vlm_fo1_available: false,
      visual_prompt_available: false,
    });

    render(
      wrap(
        <AutoAnnotateDialog
          assetId="a1"
          taskId="t1"
          classes={baseClasses}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));

    // Wait for the dialog body to render the existing Text controls.
    await screen.findByTestId("auto-annotate-class-c1");
    // Capability missing → no tab buttons.
    expect(screen.queryByTestId("auto-annotate-mode-text")).toBeNull();
    expect(screen.queryByTestId("auto-annotate-mode-visual")).toBeNull();
  });

  it("shows the visual tab when visual_prompt_available === true; switching reveals the ref-kind toggle", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      variant: "sam3",
      vlm_fo1_available: false,
      visual_prompt_available: true,
    });

    render(
      wrap(
        <AutoAnnotateDialog
          assetId="a1"
          taskId="t1"
          classes={baseClasses}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));

    const visualBtn = await screen.findByTestId(
      "auto-annotate-mode-visual",
    );
    fireEvent.click(visualBtn);

    expect(await screen.findByTestId("auto-visual-ref-kind")).toBeTruthy();
    expect(screen.getByTestId("auto-visual-ref-kind-bbox")).toBeTruthy();
    expect(screen.getByTestId("auto-visual-ref-kind-polygon")).toBeTruthy();
  });

  it("disables Run when no picks are made", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      variant: "sam3",
      vlm_fo1_available: false,
      visual_prompt_available: true,
    });

    render(
      wrap(
        <AutoAnnotateDialog
          assetId="a1"
          taskId="t1"
          classes={baseClasses}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));
    const visualBtn = await screen.findByTestId(
      "auto-annotate-mode-visual",
    );
    fireEvent.click(visualBtn);

    const runBtn = (await screen.findByTestId(
      "auto-annotate-run",
    )) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    expect(screen.getByTestId("auto-visual-empty-hint")).toBeTruthy();
  });

  it("switching ref-kind with picks present opens the confirm modal", async () => {
    (modelsApi.samStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      variant: "sam3",
      vlm_fo1_available: false,
      visual_prompt_available: true,
    });

    // Use assetId="other" so the picker reads refs from the fetched
    // task-annotations map (current-asset path uses the live editor
    // store which is empty in this test).
    render(
      wrap(
        <AutoAnnotateDialog
          assetId="other"
          taskId="t1"
          classes={baseClasses}
        />,
      ),
    );

    fireEvent.click(screen.getByTestId("auto-annotate-trigger"));
    const visualBtn = await screen.findByTestId(
      "auto-annotate-mode-visual",
    );
    fireEvent.click(visualBtn);

    // Toggle the bbox ref (only one visible because filter = bbox).
    const bboxRef = await waitFor(() =>
      screen.getByTestId("yoloe-visual-ref-ann-1"),
    );
    const toggleBtn = bboxRef.querySelector(
      "button[aria-pressed]",
    ) as HTMLButtonElement;
    fireEvent.click(toggleBtn);

    // Now picks > 0; switching to polygon should show confirm modal.
    fireEvent.click(screen.getByTestId("auto-visual-ref-kind-polygon"));
    expect(
      await screen.findByTestId("auto-visual-switch-confirm"),
    ).toBeTruthy();
  });
});

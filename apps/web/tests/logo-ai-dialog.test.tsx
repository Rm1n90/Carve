// Armin Mehri — mehri.armin@gmail.com
/**
 * LogoAiDialog.
 *
 * Asserts:
 *   - renders nothing unless the server allows it and a provider has a key
 *   - "This image" sends the chosen provider / model / effort / classes
 *   - the effort control is disabled for a model without one
 *   - a many-asset scope shows a cost estimate and starts a job with the
 *     chosen delivery, then lands on the Runs tab
 *   - an in-flight run shows on the toolbar button, and the editor is
 *     told when it finishes
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

vi.mock("@/api/logoAi", async () => {
  const actual =
    await vi.importActual<typeof import("@/api/logoAi")>("@/api/logoAi");
  return {
    ...actual,
    logoAiApi: {
      config: vi.fn(),
      detect: vi.fn(),
      estimate: vi.fn(),
      createJob: vi.fn(),
      listJobs: vi.fn(),
      getJob: vi.fn(),
      cancelJob: vi.fn(),
      filterPreview: vi.fn(),
      filterApply: vi.fn(),
      getPrompt: vi.fn(),
      savePrompt: vi.fn(),
    },
  };
});

vi.mock("@/api/assets", () => ({
  assetsApi: {
    listForTask: vi.fn().mockResolvedValue([
      { id: "a1", original_name: "1.jpg", kind: "image" },
      { id: "a2", original_name: "2.jpg", kind: "image" },
      { id: "a3", original_name: "3.jpg", kind: "image" },
    ]),
  },
}));

vi.mock("@/api/annotations", () => ({
  annotationsApi: { listForTaskRaw: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

import { logoAiApi, type LogoAiConfig, type LogoAiJob } from "@/api/logoAi";
import { LogoAiDialog } from "@/components/annotation/LogoAiDialog";
import { showToast } from "@/lib/toast";
import { useDialogPrefs } from "@/state/dialogPrefs";

const api = logoAiApi as unknown as Record<
  keyof typeof logoAiApi,
  ReturnType<typeof vi.fn>
>;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function config(overrides: Partial<LogoAiConfig> = {}): LogoAiConfig {
  return {
    allowed: true,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        configured: true,
        env_var: "ANTHROPIC_API_KEY",
        supports_flex: false,
        default_check_model: null,
        default_check_effort: null,
        default_model: "claude-opus-5-5",
        models: [
          {
            id: "claude-opus-5-5", label: "Claude Opus 5.5", blurb: "Recommended.",
            efforts: EFFORTS, default_effort: "medium", input_usd: 4, output_usd: 20,
            supports_batch: true,
          },
          {
            id: "claude-haiku-4-5", label: "Claude Haiku 4.5", blurb: "Cheapest.",
            efforts: [], default_effort: null, input_usd: 1, output_usd: 5,
            supports_batch: true,
          },
          {
            id: "claude-fable-5-1", label: "Claude Fable 5.1", blurb: "Not in batch.",
            efforts: EFFORTS, default_effort: "medium", input_usd: 10, output_usd: 50,
            supports_batch: false,
          },
        ],
      },
      {
        id: "openai",
        label: "OpenAI",
        configured: false,
        env_var: "OPENAI_API_KEY",
        supports_flex: true,
        default_check_model: "gpt-6.1-sol",
        default_check_effort: "low",
        default_model: "gpt-6.1-sol",
        models: [
          {
            id: "gpt-6.1-sol", label: "GPT-6.1 Sol", blurb: "Balanced.",
            efforts: EFFORTS, default_effort: "medium", input_usd: 2, output_usd: 10,
            supports_batch: false,
          },
        ],
      },
    ],
    details: ["low", "standard", "high", "max"],
    default_detail: "standard",
    tilings: ["off", "auto", "fine"],
    default_tiling: "off",
    max_references: 16,
    ...overrides,
  };
}

function job(overrides: Partial<LogoAiJob> = {}): LogoAiJob {
  return {
    id: "job-1",
    task_id: "t1",
    delivery: "batch",
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "medium",
    label: null,
    status: "submitted",
    progress: 0.4,
    total_assets: 3,
    prepared_assets: 3,
    done_assets: 1,
    failed_assets: 0,
    skipped_assets: 0,
    annotations_created: 2,
    rejected_boxes: 0,
    total_requests: 2,
    finished_requests: 1,
    usage: {},
    cost_usd: 0.012,
    estimated_cost_usd: 0.03,
    errors: [],
    error: null,
    notice: null,
    resume_after: null,
    created_at: new Date().toISOString(),
    started_at: null,
    submitted_at: null,
    expires_at: null,
    completed_at: null,
    ...overrides,
  };
}

const classes = [
  { id: "c1", project_id: "p1", idx: 0, name: "Acme", color: "#f00", attributes: {}, created_at: "2026-01-01T00:00:00Z" },
  { id: "c2", project_id: "p1", idx: 1, name: "Globex", color: "#0f0", attributes: {}, created_at: "2026-01-01T00:00:00Z" },
];

function renderDialog(onSuccess = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <LogoAiDialog assetId="a1" taskId="t1" classes={classes} onSuccess={onSuccess} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { qc, invalidate, onSuccess };
}

async function openDialog() {
  fireEvent.click(await screen.findByTestId("logo-ai-open"));
  await screen.findByTestId("logo-ai-dialog");
}

beforeEach(() => {
  vi.clearAllMocks();
  useDialogPrefs.setState({ logoAiByTask: {} });
  api.config.mockResolvedValue(config());
  api.listJobs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("LogoAiDialog", () => {
  it("renders nothing when the task does not allow it", async () => {
    api.config.mockResolvedValue(config({ allowed: false }));
    renderDialog();
    await waitFor(() => expect(api.config).toHaveBeenCalledWith("t1"));
    expect(screen.queryByTestId("logo-ai-open")).toBeNull();
  });

  it("renders nothing when no provider has a key", async () => {
    const c = config();
    c.providers.forEach((p) => (p.configured = false));
    api.config.mockResolvedValue(c);
    renderDialog();
    await waitFor(() => expect(api.config).toHaveBeenCalled());
    expect(screen.queryByTestId("logo-ai-open")).toBeNull();
  });

  it("offers only configured providers and runs on this image", async () => {
    api.detect.mockResolvedValue({
      annotations: [],
      annotations_created: 2,
      below_threshold: 1,
      mostly_hidden: 3,
      overwrite_skipped: false,
      usage: {},
      cost_usd: 0.0231,
    });
    const { onSuccess } = renderDialog();
    await openDialog();

    const provider = screen.getByTestId("logo-ai-provider") as HTMLSelectElement;
    expect(Array.from(provider.options).map((o) => o.value)).toEqual(["anthropic"]);
    expect((screen.getByTestId("logo-ai-model") as HTMLSelectElement).value).toBe(
      "claude-opus-5-5",
    );
    expect((screen.getByTestId("logo-ai-effort") as HTMLSelectElement).value).toBe("medium");

    fireEvent.change(screen.getByTestId("logo-ai-effort"), { target: { value: "low" } });
    fireEvent.click(screen.getByTestId("logo-ai-run"));

    await waitFor(() => expect(api.detect).toHaveBeenCalledTimes(1));
    const [assetId, body] = api.detect.mock.calls[0];
    expect(assetId).toBe("a1");
    expect(body).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "low",
      // A small project is pre-filled with one row per class.
      prompts: [
        { class_id: "c1", prompt: "" },
        { class_id: "c2", prompt: "" },
      ],
      references: [],
      // The server's default, not a value baked into the dialog.
      detail: "standard",
      tiling: "off",
      // Logos less than half in view are left out unless asked otherwise.
      min_visible: 60,
      overwrite: false,
      flex: false,
      // The second look at every box is on unless switched off, with
      // the provider's default check model (here: the run's own).
      double_check: true,
      check_model: "claude-opus-5-5",
      check_effort: "low",
    });
    expect(body).not.toHaveProperty("asset_ids");
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(2));
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("created 2 boxes · 3 mostly hidden left out"),
      expect.anything(),
    );
  });

  it("does not offer Batch for a model the provider's batch API refuses", async () => {
    renderDialog();
    await openDialog();
    fireEvent.click(
      screen.getByTestId("logo-ai-scope-all").querySelector("input") as HTMLInputElement,
    );
    fireEvent.click(screen.getByTestId("logo-ai-delivery-batch"));
    const batch = screen.getByTestId("logo-ai-delivery-batch") as HTMLButtonElement;
    expect(batch.disabled).toBe(false);

    fireEvent.change(screen.getByTestId("logo-ai-model"), {
      target: { value: "claude-fable-5-1" },
    });
    // Greyed out, says why, and the run falls back to Realtime rather
    // than submitting a batch the provider would refuse.
    await waitFor(() => expect(batch.disabled).toBe(true));
    expect(batch.textContent).toContain("Not offered for Claude Fable 5.1");
    expect(screen.getByTestId("logo-ai-run").textContent).toBe("Run on all assets");
  });

  it("lets the check model and effort be chosen", async () => {
    api.detect.mockResolvedValue({
      annotations: [], annotations_created: 0, below_threshold: 0, mostly_hidden: 0,
      rejected: 0, overwrite_skipped: false, usage: {}, cost_usd: 0,
    });
    renderDialog();
    await openDialog();
    const checkModel = screen.getByTestId("logo-ai-check-model") as HTMLSelectElement;
    // No tested default for this provider: it starts on the run's own model.
    expect(checkModel.value).toBe("claude-opus-5-5");
    fireEvent.change(checkModel, { target: { value: "claude-haiku-4-5" } });
    // Haiku has no effort control.
    expect((screen.getByTestId("logo-ai-check-effort") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("logo-ai-run"));
    await waitFor(() => expect(api.detect).toHaveBeenCalled());
    expect(api.detect.mock.calls[0][1]).toMatchObject({
      model: "claude-opus-5-5",
      double_check: true,
      check_model: "claude-haiku-4-5",
      check_effort: null,
    });

    // Switched off: nothing about the check is sent.
    fireEvent.click(screen.getByTestId("logo-ai-open"));
    fireEvent.click(await screen.findByTestId("logo-ai-double-check"));
    expect(screen.queryByTestId("logo-ai-check-model")).toBeNull();
  });

  it("offers the double-check for realtime runs only", async () => {
    renderDialog();
    await openDialog();
    const box = () => screen.queryByTestId("logo-ai-double-check");
    expect(box()).not.toBeNull();
    fireEvent.click(
      screen.getByTestId("logo-ai-scope-all").querySelector("input") as HTMLInputElement,
    );
    expect(box()).not.toBeNull();
    // A batch only hands its boxes over at the end: nothing to check yet.
    fireEvent.click(screen.getByTestId("logo-ai-delivery-batch"));
    await waitFor(() => expect(box()).toBeNull());
    api.createJob.mockResolvedValue(job({ status: "queued" }));
    fireEvent.click(screen.getByTestId("logo-ai-run"));
    await waitFor(() => expect(api.createJob).toHaveBeenCalled());
    expect(api.createJob.mock.calls[0][1]).toMatchObject({ delivery: "batch", double_check: false });
  });

  it("disables effort for a model that has no effort control", async () => {
    renderDialog();
    await openDialog();
    fireEvent.change(screen.getByTestId("logo-ai-model"), {
      target: { value: "claude-haiku-4-5" },
    });
    const effort = screen.getByTestId("logo-ai-effort") as HTMLSelectElement;
    expect(effort.disabled).toBe(true);

    api.detect.mockResolvedValue({
      annotations: [], annotations_created: 0, below_threshold: 0,
      mostly_hidden: 0, overwrite_skipped: false, usage: {}, cost_usd: 0,
    });
    fireEvent.click(screen.getByTestId("logo-ai-run"));
    await waitFor(() => expect(api.detect).toHaveBeenCalled());
    expect(api.detect.mock.calls[0][1]).toMatchObject({
      model: "claude-haiku-4-5",
      effort: null,
    });
  });

  it("estimates a many-asset run and submits it as a batch", async () => {
    api.estimate.mockResolvedValue({
      assets: 3, requests: 3, image_tokens: 9000, prefix_tokens: 1500,
      prefix_cached: true, min_cache_tokens: 512, output_tokens: 3000,
      based_on_requests: 12,
      cost_realtime_usd: 0.1, cost_flex_usd: null, cost_batch_usd: 0.05,
    });
    api.createJob.mockResolvedValue(job({ status: "queued", progress: 0 }));
    renderDialog();
    await openDialog();

    fireEvent.click(
      screen.getByTestId("logo-ai-scope-all").querySelector("input") as HTMLInputElement,
    );
    fireEvent.click(screen.getByTestId("logo-ai-delivery-batch"));
    fireEvent.click(screen.getByTestId("logo-ai-skip-annotated"));

    await waitFor(() => expect(api.estimate).toHaveBeenCalled(), { timeout: 3000 });
    const estimate = await screen.findByTestId("logo-ai-estimate");
    await waitFor(() => expect(estimate.textContent).toContain("$0.050"));
    expect(estimate.textContent).toContain("Realtime $0.100");
    expect(estimate.textContent).toContain("Based on what 12 earlier requests");

    // The list is refetched after the job is created.
    api.listJobs.mockResolvedValue([job({ status: "queued", progress: 0 })]);
    fireEvent.click(screen.getByTestId("logo-ai-run"));
    await waitFor(() => expect(api.createJob).toHaveBeenCalledTimes(1));
    const [taskId, body] = api.createJob.mock.calls[0];
    expect(taskId).toBe("t1");
    expect(body).toMatchObject({ delivery: "batch", skip_annotated: true });
    expect(body).not.toHaveProperty("asset_ids");

    // Lands on the Runs tab with the new run listed.
    expect(await screen.findByTestId("logo-ai-run-job-1")).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("collected automatically"),
      expect.anything(),
    );
  });

  it("shows an in-flight run on the button and reports when it finishes", async () => {
    api.listJobs.mockResolvedValue([job()]);
    const { qc, invalidate, onSuccess } = renderDialog();

    expect((await screen.findByTestId("logo-ai-active-badge")).textContent).toBe("1");

    // Opening goes straight to the run that needs attention.
    fireEvent.click(screen.getByTestId("logo-ai-open"));
    const row = await screen.findByTestId("logo-ai-run-job-1");
    expect(row.textContent).toContain("Waiting for provider");
    expect(row.textContent).toContain("1/2 requests answered");
    expect(row.textContent).toContain("2 boxes");

    api.listJobs.mockResolvedValue([
      job({ status: "completed", progress: 1, done_assets: 3, annotations_created: 7 }),
    ]);
    await qc.refetchQueries({ queryKey: ["logo-ai", "jobs", "t1"] });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(7));
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("finished: 7 boxes"),
      expect.anything(),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["annotations", "t1"] });
    await waitFor(() =>
      expect(screen.queryByTestId("logo-ai-active-badge")).toBeNull(),
    );
  });

  it("does not announce runs that had already finished on load", async () => {
    api.listJobs.mockResolvedValue([job({ status: "completed", progress: 1 })]);
    const { onSuccess } = renderDialog();
    await screen.findByTestId("logo-ai-open");
    await waitFor(() => expect(api.listJobs).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("cancels a run from the Runs tab", async () => {
    api.listJobs.mockResolvedValue([job({ delivery: "realtime", status: "running" })]);
    api.cancelJob.mockResolvedValue(job({ status: "canceling" }));
    renderDialog();
    fireEvent.click(await screen.findByTestId("logo-ai-open"));
    fireEvent.click(await screen.findByTestId("logo-ai-run-cancel-job-1"));
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("t1", "job-1"));
  });

  it("shows how many boxes the second look rejected", async () => {
    api.listJobs.mockResolvedValue([
      job({ delivery: "realtime", status: "completed", progress: 1, annotations_created: 271, rejected_boxes: 14 }),
    ]);
    renderDialog();
    fireEvent.click(await screen.findByTestId("logo-ai-open"));
    fireEvent.click(await screen.findByTestId("logo-ai-tab-runs"));
    const row = await screen.findByTestId("logo-ai-run-job-1");
    expect(row.textContent).toContain("271 boxes · 14 rejected on the second look");
  });

  it("shows the task's instructions and saves an edited text", async () => {
    const prompt = {
      instructions: "Default detection text.",
      check_instructions: "Default check text.",
      custom: false,
      check_custom: false,
      default_instructions: "Default detection text.",
      default_check_instructions: "Default check text.",
      format_preview: "## Coordinates\n...\n## Target classes",
      check_format_preview: "Return one row per tile",
      max_chars: 40000,
      cache_min_chars: 10,
      updated_at: null,
    };
    (api as unknown as Record<string, ReturnType<typeof vi.fn>>).getPrompt.mockResolvedValue(prompt);
    (api as unknown as Record<string, ReturnType<typeof vi.fn>>).savePrompt.mockImplementation(
      async (_t: string, body: { instructions: string; check_instructions: string }) => ({
        ...prompt, instructions: body.instructions, custom: true,
      }),
    );
    renderDialog();
    await openDialog();
    fireEvent.click(screen.getByTestId("logo-ai-tab-prompt"));

    const text = (await screen.findByTestId("logo-ai-prompt-instructions")) as HTMLTextAreaElement;
    await waitFor(() => expect(text.value).toBe("Default detection text."));
    expect(screen.getByTestId("logo-ai-prompt-instructions-state").textContent).toBe("Default");
    // The fixed part is shown, not editable.
    expect(screen.getByTestId("logo-ai-prompt").textContent).toContain("## Target classes");
    const save = screen.getByTestId("logo-ai-prompt-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);  // nothing changed yet

    fireEvent.change(text, { target: { value: "Only sponsor logos on the cars." } });
    expect(screen.getByTestId("logo-ai-prompt-instructions-state").textContent).toBe(
      "Custom for this task",
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        (api as unknown as Record<string, ReturnType<typeof vi.fn>>).savePrompt,
      ).toHaveBeenCalledWith(
        "t1",
        { instructions: "Only sponsor logos on the cars.", check_instructions: "Default check text." },
        { provider: "anthropic", model: "claude-opus-5-5" },
      ),
    );

    // Back to the default with one click.
    fireEvent.click(screen.getByTestId("logo-ai-prompt-instructions-reset"));
    expect(text.value).toBe("Default detection text.");
  });

  it("says what a waiting run is waiting for", async () => {
    api.listJobs.mockResolvedValue([
      job({
        delivery: "realtime",
        status: "running",
        notice: "Waiting: the provider cannot be reached. The run continues by itself.",
        resume_after: new Date(Date.now() + 5 * 60_000).toISOString(),
        errors: ["batch part 2: the provider did not get to 3 images; sent again automatically"],
      }),
    ]);
    renderDialog();
    fireEvent.click(await screen.findByTestId("logo-ai-open"));
    const notice = await screen.findByTestId("logo-ai-run-notice-job-1");
    expect(notice.textContent).toContain("the provider cannot be reached");
    expect(notice.textContent).toContain("Next try");
    // Nothing failed, so the list under it is not called failures.
    expect(screen.getByText("1 note")).toBeTruthy();
  });

  it("force-stops a stuck batch only after a confirmation", async () => {
    api.listJobs.mockResolvedValue([job({ delivery: "batch", status: "canceling" })]);
    api.cancelJob.mockResolvedValue(job({ delivery: "batch", status: "canceled" }));
    renderDialog();
    fireEvent.click(await screen.findByTestId("logo-ai-open"));
    const stop = await screen.findByTestId("logo-ai-run-cancel-job-1");
    expect(stop.textContent).toBe("Force stop");

    fireEvent.click(stop);
    // Nothing is sent until the loss of uncollected results is accepted.
    const accept = await screen.findByRole("button", { name: "Force stop" });
    expect(api.cancelJob).not.toHaveBeenCalled();
    fireEvent.click(accept);
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith("t1", "job-1", true));
  });

  it("lists a single-image run with its tokens and how long it took", async () => {
    api.listJobs.mockResolvedValue([
      job({
        delivery: "single",
        label: "img-417.jpg",
        status: "completed",
        progress: 1,
        effort: "low",
        total_assets: 1,
        done_assets: 1,
        annotations_created: 33,
        cost_usd: 0.0163,
        estimated_cost_usd: null,
        usage: {
          input_tokens: 2465, cache_read_tokens: 1446, cache_write_tokens: 0,
          output_tokens: 1119, reasoning_tokens: 585, requests: 1,
        },
        started_at: "2026-09-30T10:00:00Z",
        completed_at: "2026-09-30T10:00:32Z",
      }),
    ]);
    renderDialog();
    fireEvent.click(await screen.findByTestId("logo-ai-open"));
    fireEvent.click(await screen.findByTestId("logo-ai-tab-runs"));
    const row = await screen.findByTestId("logo-ai-run-job-1");
    expect(row.textContent).toContain("Single image");
    expect(row.textContent).toContain("img-417.jpg");
    expect(row.textContent).toContain("took 32s");
    expect(row.textContent).toContain("Tokens: 2.5k in + 1.4k cached · 1.1k out (585 reasoning)");
    expect(row.textContent).toContain("Cost $0.016");
  });

  it("moves a saved setup to the standard image detail once", async () => {
    // What the browser holds from before the default changed.
    window.localStorage.setItem(
      "carve-dialog-prefs",
      JSON.stringify({
        version: 1,
        state: {
          autoAnnotateByTask: { t9: { text: { rows: [] } } },
          smartFindByTask: {},
          logoAiByTask: { t1: { provider: "openai", model: "gpt-6.1-sol", detail: "max", rows: [] } },
        },
      }),
    );
    await useDialogPrefs.persist.rehydrate();
    const state = useDialogPrefs.getState();
    expect(state.logoAiByTask.t1.detail).toBe("standard");
    // The rest of the saved setup, and the other dialogs', are kept.
    expect(state.logoAiByTask.t1.model).toBe("gpt-6.1-sol");
    expect(state.autoAnnotateByTask.t9).toBeDefined();
  });
});

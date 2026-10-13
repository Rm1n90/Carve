// Armin Mehri — mehri.armin@gmail.com
//
// The task-wide box conversion runs on the server; the dialog starts it
// and shows where it is (image in work, done / left, time to go, what it
// made, the latest images), stops it and resumes it.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { boxConvertApi, type BoxConvertJob } from "@/api/boxConvert";
import { BoxConvertDialog, formatDuration } from "@/components/annotation/BoxConvertDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const RUNNING: BoxConvertJob = {
  job_id: "j1",
  task_id: "t1",
  status: "running",
  done: 1234,
  total: 25734,
  failed: 2,
  errors: ["a.jpg: boom"],
  error: null,
  boxes: 45000,
  polygons: 38000,
  masks: 6200,
  merged: 300,
  kept: 500,
  low_score: 120,
  images_with_boxes: 1230,
  started_at: 1,
  updated_at: 2,
  current: { index: 1235, asset_id: "a1235", name: "motogp_0042.jpg" },
  recent: [
    { index: 1234, asset_id: "a1234", name: "f1_0007.jpg", boxes: 30, polygons: 25, masks: 4, merged: 0, kept: 1, low_score: 0, s: 3.1 },
  ],
  seconds_per_image: 3.4,
  eta_seconds: 3.4 * (25734 - 1234),
  stalled: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(boxConvertApi, "previewUrl").mockResolvedValue("blob:preview");
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Box conversion dialog", () => {
  it("offers to convert what is left, and starts it", async () => {
    vi.spyOn(boxConvertApi, "get").mockResolvedValue({ job: null, left: { boxes: 946737, images: 25621 } });
    const start = vi.spyOn(boxConvertApi, "start").mockResolvedValue({ ...RUNNING, status: "queued", done: 0 });
    render(wrap(<BoxConvertDialog open onOpenChange={() => {}} projectId="p" taskId="t1" />));
    expect((await screen.findByTestId("box-convert-left")).textContent).toContain("946,737 boxes on 25,621 images");
    fireEvent.click(screen.getByTestId("box-convert-start"));
    await waitFor(() => expect(start).toHaveBeenCalledWith("t1"));
  });

  it("shows where a running conversion is, and stops it", async () => {
    vi.spyOn(boxConvertApi, "get").mockResolvedValue({ job: RUNNING, left: null });
    const cancel = vi.spyOn(boxConvertApi, "cancel").mockResolvedValue();
    render(wrap(<BoxConvertDialog open onOpenChange={() => {}} projectId="p" taskId="t1" />));
    expect((await screen.findByTestId("box-convert-count")).textContent).toBe("1,234 of 25,734 images · 24,500 left");
    expect(screen.getByTestId("box-convert-eta").textContent).toContain("about 23 h 8 min to go (3.4 s per image)");
    expect(screen.getByTestId("box-convert-current").textContent).toContain("#1,235 motogp_0042.jpg");
    const stats = screen.getByTestId("box-convert-stats").textContent ?? "";
    expect(stats).toContain("38,000polygons");
    expect(stats).toContain("6,200masks");
    expect(stats).toContain("500left as boxes");
    // The latest image, drawn with its shapes, and its counts.
    const card = await screen.findByTestId("box-convert-image");
    expect(card.textContent).toContain("#1,234 f1_0007.jpg");
    expect(card.textContent).toContain("25 polygons · 4 masks · 1 left as box");
    await waitFor(() => expect(boxConvertApi.previewUrl).toHaveBeenCalledWith("t1", "a1234", 360));
    fireEvent.click(card);
    expect(await screen.findByTestId("box-convert-big")).toBeTruthy();
    await waitFor(() => expect(boxConvertApi.previewUrl).toHaveBeenCalledWith("t1", "a1234", 1600));

    fireEvent.click(screen.getByTestId("box-convert-stop"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("t1", "j1"));
  });

  it("resumes a stopped run where it was", async () => {
    vi.spyOn(boxConvertApi, "get").mockResolvedValue({
      job: { ...RUNNING, status: "canceled", current: null, eta_seconds: null },
      left: { boxes: 900000, images: 24400 },
    });
    const resume = vi.spyOn(boxConvertApi, "resume").mockResolvedValue(RUNNING);
    render(wrap(<BoxConvertDialog open onOpenChange={() => {}} projectId="p" taskId="t1" />));
    const btn = await screen.findByTestId("box-convert-resume");
    expect(btn.textContent).toContain("Resume from #1,235");
    expect(screen.queryByTestId("box-convert-start")).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(resume).toHaveBeenCalledWith("t1", "j1"));
  });

  it("offers Resume for a run that stalled", async () => {
    vi.spyOn(boxConvertApi, "get").mockResolvedValue({ job: { ...RUNNING, stalled: true }, left: null });
    render(wrap(<BoxConvertDialog open onOpenChange={() => {}} projectId="p" taskId="t1" />));
    expect((await screen.findByTestId("box-convert-status")).textContent).toContain("No progress for 20 minutes");
    expect(screen.getByTestId("box-convert-resume")).toBeTruthy();
    expect(screen.queryByTestId("box-convert-stop")).toBeNull();
  });

  it("says why it could not start", async () => {
    vi.spyOn(boxConvertApi, "get").mockResolvedValue({ job: null, left: { boxes: 5, images: 1 } });
    vi.spyOn(boxConvertApi, "start").mockRejectedValue({
      response: { data: { error: "wrong_sam_variant", loaded: "sam2.1-tiny" } },
    });
    render(wrap(<BoxConvertDialog open onOpenChange={() => {}} projectId="p" taskId="t1" />));
    fireEvent.click(await screen.findByTestId("box-convert-start"));
    expect((await screen.findByTestId("box-convert-refused")).textContent).toContain("SAM sam2.1-tiny is loaded");
  });
});

describe("formatDuration", () => {
  it("reads as minutes, hours or days", () => {
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(25 * 60)).toBe("25 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    expect(formatDuration(30 * 3600 + 600)).toBe("1 d 6 h");
  });
});

// Armin Mehri — mehri.armin@gmail.com
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ResumeProgressBanner } from "../ResumeProgressBanner";

const mockResumeStatus = vi.fn();
vi.mock("../../../api/tasks", () => ({
  tasksApi: {
    resumeStatus: (...args: unknown[]) => mockResumeStatus(...args),
  },
}));

function withClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  mockResumeStatus.mockReset();
});

describe("<ResumeProgressBanner />", () => {
  it("renders nothing while loading", () => {
    mockResumeStatus.mockReturnValue(new Promise(() => {}));
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    expect(
      screen.queryByText(/you last annotated/i),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when last_asset_id is null", async () => {
    mockResumeStatus.mockResolvedValue({
      last_asset_id: null,
      last_frame_id: null,
      annotated_assets: 0,
      total_assets: 10,
      last_activity_at: null,
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });

  it("renders nothing when the resume target is the current asset", async () => {
    mockResumeStatus.mockResolvedValue({
      last_asset_id: "a-current",
      last_frame_id: "f1",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });

  it("shows banner with counts and offers Resume + Dismiss", async () => {
    mockResumeStatus.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 350,
      total_assets: 1000,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    expect(
      await screen.findByText((t) => /350 of 1000/.test(t)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("calls onResume with the last_asset_id when Resume clicked", async () => {
    const onResume = vi.fn();
    mockResumeStatus.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={onResume}
        />,
      ),
    );
    const btn = await screen.findByRole("button", { name: /resume/i });
    fireEvent.click(btn);
    expect(onResume).toHaveBeenCalledWith("a-resume");
  });

  it("hides itself permanently after Dismiss in this session", async () => {
    mockResumeStatus.mockResolvedValue({
      last_asset_id: "a-resume",
      last_frame_id: "f-resume",
      annotated_assets: 5,
      total_assets: 10,
      last_activity_at: new Date(Date.now() - 60_000).toISOString(),
    });
    render(
      withClient(
        <ResumeProgressBanner
          projectId="p1"
          taskId="t1"
          currentAssetId="a-current"
          onResume={() => undefined}
        />,
      ),
    );
    const dismiss = await screen.findByRole("button", { name: /dismiss/i });
    fireEvent.click(dismiss);
    expect(screen.queryByText(/you last annotated/i)).not.toBeInTheDocument();
  });
});

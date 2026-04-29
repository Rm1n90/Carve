import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// v3.3 audit issue 3a — the dialog used to claim "Class names are
// auto-detected from the model" while the backend silently stored []. We
// now actually delegate to the model service /yolo/inspect endpoint, so
// the dialog copy is honest. Lock that in.

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
    list: vi.fn().mockResolvedValue([
      { id: "p1", name: "Project One", description: null, owner_id: "u1", created_at: "" },
    ]),
  },
}));

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
});

describe("v3.3 issue 3a — UploadWeightDialog copy", () => {
  it("does NOT claim class names are auto-detected (the old lie)", async () => {
    render(
      wrap(<UploadWeightDialog open onOpenChange={() => undefined} defaultProjectId="p1" />),
    );
    await screen.findByText(/upload yolo weight/i);

    // The pre-v3.3 string lied — we never opened the .pt. Make sure the
    // exact wording is gone so future regressions don't sneak it back in.
    expect(
      screen.queryByText(/Class names are auto-detected from the model/i),
    ).toBeNull();
  });

  it("explains that the backend will extract class names from the file", async () => {
    render(
      wrap(<UploadWeightDialog open onOpenChange={() => undefined} defaultProjectId="p1" />),
    );
    await screen.findByText(/upload yolo weight/i);

    // Honest copy: we tell the user the names will be pulled from the file
    // after upload (via the model service /yolo/inspect endpoint).
    expect(
      screen.getByText(/extract the class names from your weight file/i),
    ).toBeTruthy();
  });
});

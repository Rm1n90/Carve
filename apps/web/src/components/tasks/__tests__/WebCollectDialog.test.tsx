// Armin Mehri — mehri.armin@gmail.com
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/Tooltip";
import type { WebCollectKeywordIn, WebCollectState } from "@/api/webCollect";

import { WebCollectDialog } from "../WebCollectDialog";

const state = (keywords: WebCollectState["keywords"] = []): WebCollectState => ({
  keywords,
  active: null,
  recent: [],
  sources: [
    { name: "bing", label: "Bing", kind: "web", default: true, needs: null },
    { name: "commons", label: "Wikimedia Commons", kind: "open", default: true, needs: "a contact address" },
    { name: "openverse", label: "Openverse", kind: "open", default: true, needs: null },
  ],
  blocked_counts: { stock: 10, ai: 5, chinese: 5 },
  min_side_default: 500,
});

const api = vi.hoisted(() => ({
  state: vi.fn(),
  saveKeywords: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/api/webCollect", async (orig) => ({
  ...(await orig<typeof import("@/api/webCollect")>()),
  webCollectApi: api,
}));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <WebCollectDialog taskId="t1" open />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.state.mockReset().mockResolvedValue(state());
  api.saveKeywords.mockReset().mockImplementation(async (_t: string, kws: WebCollectKeywordIn[]) =>
    state(kws.map((k, i) => ({ id: k.id ?? `k${i}`, keyword: k.keyword, slug: "s", target: k.target, have: 0, exhausted: false }))),
  );
});

describe("<WebCollectDialog />", () => {
  it("has Keywords, Settings and Past runs tabs", async () => {
    renderDialog();
    expect(await screen.findByTestId("web-collect-tab-keywords")).toBeTruthy();
    expect(screen.getByTestId("web-collect-tab-settings")).toBeTruthy();
    expect(screen.getByTestId("web-collect-tab-history")).toBeTruthy();
  });

  it("adds a typed keyword and saves the list by itself", async () => {
    renderDialog();
    const input = await screen.findByTestId("web-collect-new-keyword");
    fireEvent.change(input, { target: { value: "  Tenneco   logo " } });
    fireEvent.change(screen.getByTestId("web-collect-new-count"), { target: { value: "250" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.saveKeywords).toHaveBeenCalled());
    expect(api.saveKeywords.mock.calls[0][1]).toEqual([{ id: undefined, keyword: "Tenneco logo", target: 250 }]);
    expect(await screen.findByText("Tenneco logo")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Collect 250 images/ })).toBeTruthy();
  });

  it("number fields take what is typed (no 50-step or 'valid value' trouble)", async () => {
    renderDialog();
    const input = await screen.findByTestId("web-collect-new-keyword");
    const count = screen.getByTestId("web-collect-new-count") as HTMLInputElement;
    expect(count.value).toBe("300");
    fireEvent.change(count, { target: { value: "" } }); // cleared to type a new number
    expect(count.value).toBe("");
    fireEvent.change(count, { target: { value: "300" } });
    fireEvent.change(input, { target: { value: "Pirelli tyre" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.saveKeywords).toHaveBeenCalled());
    expect(api.saveKeywords.mock.calls[0][1][0].target).toBe(300);

    // The row's number: type, then Enter; arrows change it by 1.
    const wanted = (await screen.findByLabelText("Images wanted for Pirelli tyre")) as HTMLInputElement;
    fireEvent.focus(wanted);
    fireEvent.change(wanted, { target: { value: "450" } });
    fireEvent.keyDown(wanted, { key: "Enter" });
    fireEvent.keyDown(wanted, { key: "ArrowUp" });
    expect(wanted.value).toBe("451");
    await waitFor(() => expect(api.saveKeywords.mock.calls.at(-1)![1][0].target).toBe(451), {
      timeout: 3000,
    });
  });

  it("an equal share of a total replaces every keyword's number", async () => {
    api.state.mockResolvedValue(
      state([
        { id: "a", keyword: "A", slug: "a", target: 100, have: 0, exhausted: false },
        { id: "b", keyword: "B", slug: "b", target: 700, have: 0, exhausted: false },
      ]),
    );
    renderDialog();
    expect(await screen.findByText("800")).toBeTruthy(); // total wanted
    fireEvent.change(screen.getByLabelText("Total to share"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.saveKeywords).toHaveBeenCalled());
    expect((api.saveKeywords.mock.calls.at(-1)![1] as WebCollectKeywordIn[]).map((k) => k.target)).toEqual([500, 500]);
  });

  it("pastes a list, skipping lines already there", async () => {
    api.state.mockResolvedValue(
      state([{ id: "a", keyword: "Pirelli tyre", slug: "p", target: 100, have: 0, exhausted: false }]),
    );
    renderDialog();
    fireEvent.click(await screen.findByText("Paste a list"));
    fireEvent.change(screen.getByTestId("web-collect-paste"), {
      target: { value: "Pirelli tyre\nCadillac F1 car, 500\nTenneco logo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add 2 keywords/ }));
    await waitFor(() => expect(api.saveKeywords).toHaveBeenCalled());
    const sent = api.saveKeywords.mock.calls.at(-1)![1] as WebCollectKeywordIn[];
    expect(sent.map((k) => [k.keyword, k.target])).toEqual([
      ["Pirelli tyre", 100],
      ["Cadillac F1 car", 500],
      ["Tenneco logo", 300],
    ]);
  });

  it("explains every option with a help button", async () => {
    renderDialog();
    fireEvent.mouseDown(await screen.findByTestId("web-collect-tab-settings"));
    fireEvent.click(screen.getByTestId("web-collect-tab-settings"));
    for (const label of [
      "Bing",
      "Openverse",
      "Smallest size",
      "Skip AI-made images",
      "Skip watermarked images",
      "Fill gaps from other keywords",
      "Start the search from the beginning",
    ]) {
      expect(await screen.findByRole("button", { name: new RegExp(`^About ${label}$`, "i") })).toBeTruthy();
    }
    // A source that still needs something says so and cannot be ticked.
    expect(screen.getByText("Needs a contact address")).toBeTruthy();
  });
});

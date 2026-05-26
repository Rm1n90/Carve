// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyAnnotationsDialog } from "../CopyAnnotationsDialog";
import type { Asset } from "@/api/assets";

function makeAsset(over: Partial<Asset>): Asset {
  return {
    id: over.id ?? "a",
    task_id: "t",
    kind: "image",
    xxh3_128: "x",
    mime: "image/png",
    size_bytes: 1,
    width: 1000,
    height: 800,
    frames: 1,
    original_name: over.original_name ?? "a.png",
    created_at: "2026-05-26T00:00:00Z",
    thumbnail_url: over.thumbnail_url ?? null,
    ...over,
  } as Asset;
}

describe("CopyAnnotationsDialog", () => {
  it("renders the breakdown line for non-zero counts", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src", original_name: "src.png" })}
        sourceOrdinal={42}
        totalAssets={1247}
        targetAsset={makeAsset({ id: "tgt", original_name: "tgt.png" })}
        targetExistingCount={4}
        breakdown={{ bbox: 17, polygon: 3, tag: 0, mask: 0, total: 20 }}
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText(/src\.png/)).toBeInTheDocument();
    expect(screen.getByText(/42 ?\/ ?1247/)).toBeInTheDocument();
    expect(screen.getByText(/17 bbox/)).toBeInTheDocument();
    expect(screen.getByText(/3 polygon/)).toBeInTheDocument();
    expect(screen.getByText(/Adds to 4 existing annotations/)).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: /Copy 20 annotations/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("shows 'Nothing to copy' and a Close button when breakdown total is 0", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src", original_name: "src.png" })}
        sourceOrdinal={1}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt", original_name: "tgt.png" })}
        targetExistingCount={0}
        breakdown={{ bbox: 0, polygon: 0, tag: 0, mask: 0, total: 0 }}
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByText(/Nothing to copy/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Close/i })).toBeInTheDocument();
  });

  it("shows a spinner while breakdown is loading and disables confirm", () => {
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src" })}
        sourceOrdinal={2}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt" })}
        targetExistingCount={0}
        breakdown="loading"
        onConfirm={() => Promise.resolve()}
      />,
    );

    expect(screen.getByTestId("copy-dialog-breakdown-loading")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Copy/i });
    expect(btn).toBeDisabled();
  });

  it("calls onConfirm exactly once when the primary button is clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CopyAnnotationsDialog
        open
        onOpenChange={() => {}}
        sourceAsset={makeAsset({ id: "src" })}
        sourceOrdinal={1}
        totalAssets={10}
        targetAsset={makeAsset({ id: "tgt" })}
        targetExistingCount={0}
        breakdown={{ bbox: 1, polygon: 0, tag: 0, mask: 0, total: 1 }}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Copy 1 annotation/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

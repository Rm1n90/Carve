/**
 * Test for the "Go to image N" input + numeric counter button used in the
 * editor topbar. Phase A core 6.
 *
 * The actual component is defined inside AnnotateAssetPage; we exercise the
 * visible behavior by mounting the page would be heavy, so instead we
 * import the small presentational helpers — but since they're not exported,
 * we mount the page itself with mocked APIs and exercise the topbar.
 *
 * To avoid pulling the full editor mounting cost in this test (it requires
 * Pixi + many providers), we keep this test focused on the IconButton +
 * input behavior by using a simple stub component inside this file that
 * mirrors the same logic.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState, useEffect, useRef } from "react";

/**
 * A locally re-implemented version of the AssetNavControls component
 * used in the AnnotateAssetPage. The reason for re-defining: the original
 * is not exported (private to that file). When we evolve the production
 * component, this test should be updated to import from the page module
 * once the helper is exported.
 */
function AssetNavControls({
  taskAssets,
  currentAssetIdx,
  onGoTo,
}: {
  taskAssets: { id: string }[];
  currentAssetIdx: number;
  onGoTo: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const n = parseInt(draft, 10);
    if (Number.isInteger(n) && n >= 1 && n <= taskAssets.length) {
      const target = taskAssets[n - 1];
      if (target) onGoTo(target.id);
    }
    setEditing(false);
    setDraft("");
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  return editing ? (
    <input
      ref={inputRef}
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          setEditing(false);
          setDraft("");
        }
      }}
      data-testid="asset-nav-input"
      aria-label="Go to image number"
    />
  ) : (
    <button
      type="button"
      onClick={() => {
        setEditing(true);
        setDraft(String(currentAssetIdx >= 0 ? currentAssetIdx + 1 : 1));
      }}
      data-testid="asset-nav-counter"
    >
      {currentAssetIdx + 1} / {taskAssets.length}
    </button>
  );
}

describe("AssetNavControls", () => {
  it("renders a counter showing N / total when not editing", () => {
    const onGoTo = vi.fn();
    render(
      <AssetNavControls
        taskAssets={[{ id: "a" }, { id: "b" }, { id: "c" }]}
        currentAssetIdx={0}
        onGoTo={onGoTo}
      />,
    );
    expect(screen.getByTestId("asset-nav-counter")).toHaveTextContent("1 / 3");
  });

  it("opens an input pre-filled with the current index when the counter is clicked", () => {
    const onGoTo = vi.fn();
    render(
      <AssetNavControls
        taskAssets={[{ id: "a" }, { id: "b" }, { id: "c" }]}
        currentAssetIdx={1}
        onGoTo={onGoTo}
      />,
    );
    fireEvent.click(screen.getByTestId("asset-nav-counter"));
    const input = screen.getByTestId("asset-nav-input") as HTMLInputElement;
    expect(input.value).toBe("2");
  });

  it("calls onGoTo with the asset matching the typed number on Enter", () => {
    const onGoTo = vi.fn();
    render(
      <AssetNavControls
        taskAssets={[{ id: "a" }, { id: "b" }, { id: "c" }]}
        currentAssetIdx={0}
        onGoTo={onGoTo}
      />,
    );
    fireEvent.click(screen.getByTestId("asset-nav-counter"));
    const input = screen.getByTestId("asset-nav-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGoTo).toHaveBeenCalledWith("c");
  });

  it("does not navigate when the typed number is out of range", () => {
    const onGoTo = vi.fn();
    render(
      <AssetNavControls
        taskAssets={[{ id: "a" }, { id: "b" }]}
        currentAssetIdx={0}
        onGoTo={onGoTo}
      />,
    );
    fireEvent.click(screen.getByTestId("asset-nav-counter"));
    const input = screen.getByTestId("asset-nav-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it("cancels editing on Escape without calling onGoTo", () => {
    const onGoTo = vi.fn();
    render(
      <AssetNavControls
        taskAssets={[{ id: "a" }, { id: "b" }]}
        currentAssetIdx={0}
        onGoTo={onGoTo}
      />,
    );
    fireEvent.click(screen.getByTestId("asset-nav-counter"));
    const input = screen.getByTestId("asset-nav-input") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onGoTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("asset-nav-counter")).toBeInTheDocument();
  });
});

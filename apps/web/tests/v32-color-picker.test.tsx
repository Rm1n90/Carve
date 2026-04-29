import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/classes", () => ({
  classesApi: {
    listForProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { classesApi } from "@/api/classes";
import { ClassesEditor } from "@/pages/ClassesEditor";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { PALETTE_HEX } from "@/lib/swatch";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

const fixture = [
  {
    id: "c-1",
    project_id: "p",
    idx: 0,
    name: "car",
    color: "#ef4444",
    attributes: {},
    created_at: "",
  },
];

describe("v3.2 Issue 6 — Color picker presets + custom", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("ClassesEditor (project-level form)", () => {
    it("renders the 12-swatch grid alongside the native color input", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      render(wrap(<ClassesEditor projectId="p1" />));

      // Swatch grid present.
      const grid = await screen.findByTestId("classes-editor-swatch-grid");
      expect(grid).toBeInTheDocument();
      // Exactly 12 swatch buttons.
      const swatchButtons = grid.querySelectorAll("button");
      expect(swatchButtons.length).toBe(PALETTE_HEX.length);
      expect(PALETTE_HEX.length).toBe(12);
      // Native color input still present.
      const nativeInput = screen.getByLabelText(/^color$/i) as HTMLInputElement;
      expect(nativeInput.type).toBe("color");
    });

    it("clicking a swatch updates the form's color state", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      (classesApi.create as any).mockResolvedValue({
        id: "c1",
        project_id: "p1",
        idx: 0,
        name: "car",
        color: "#22c55e",
        attributes: {},
        created_at: "2026-01-01",
      });
      render(wrap(<ClassesEditor projectId="p1" />));

      // Click the green swatch (#22C55E).
      fireEvent.click(await screen.findByTestId("classes-editor-swatch-#22C55E"));

      // Submitting the form sends the swatch color through.
      fireEvent.change(screen.getByLabelText(/class name/i), {
        target: { value: "car" },
      });
      fireEvent.click(screen.getByRole("button", { name: /add class/i }));
      await waitFor(() => {
        expect(classesApi.create).toHaveBeenCalledWith("p1", {
          idx: 0,
          name: "car",
          color: "#22C55E",
        });
      });
    });

    it("typing a hex into the native input updates the form's color state", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      (classesApi.create as any).mockResolvedValue({
        id: "c1",
        project_id: "p1",
        idx: 0,
        name: "person",
        color: "#123456",
        attributes: {},
        created_at: "2026-01-01",
      });
      render(wrap(<ClassesEditor projectId="p1" />));

      const nativeInput = (await screen.findByLabelText(/^color$/i)) as HTMLInputElement;
      fireEvent.change(nativeInput, { target: { value: "#123456" } });

      fireEvent.change(screen.getByLabelText(/class name/i), {
        target: { value: "person" },
      });
      fireEvent.click(screen.getByRole("button", { name: /add class/i }));
      await waitFor(() => {
        expect(classesApi.create).toHaveBeenCalledWith("p1", {
          idx: 0,
          name: "person",
          color: "#123456",
        });
      });
    });

    it("highlights the selected swatch when the current color matches a preset", async () => {
      (classesApi.listForProject as any).mockResolvedValue([]);
      render(wrap(<ClassesEditor projectId="p1" />));

      // Click the red swatch first.
      const redSwatch = await screen.findByTestId("classes-editor-swatch-#EF4444");
      fireEvent.click(redSwatch);
      expect(redSwatch.getAttribute("data-selected")).toBe("true");

      // After clicking a different swatch, the previous one is no longer selected.
      const blueSwatch = screen.getByTestId("classes-editor-swatch-#3B82F6");
      fireEvent.click(blueSwatch);
      expect(blueSwatch.getAttribute("data-selected")).toBe("true");
      expect(redSwatch.getAttribute("data-selected")).toBeNull();
    });
  });

  describe("ClassesPanel ColorPickerPopover (in-editor)", () => {
    it("opens the popover and shows 12 preset swatches plus a native color input", async () => {
      render(
        <ConfirmProvider>
          <ClassesPanel
            classes={fixture as any}
            onUpdateColor={() => {}}
          />
        </ConfirmProvider>,
      );

      // Open the popover by clicking the small color swatch on the row.
      fireEvent.click(screen.getByTestId("class-color-swatch"));

      // Native custom color input is present.
      const customInput = await screen.findByTestId("class-color-custom");
      expect((customInput as HTMLInputElement).type).toBe("color");

      // Preset swatches: count via aria-label `Set color #...`.
      const presetButtons = screen
        .getAllByRole("button")
        .filter((b) => /^Set color #/i.test(b.getAttribute("aria-label") ?? ""));
      expect(presetButtons.length).toBe(PALETTE_HEX.length);
    });

    it("forwards a custom hex from the native color input through onUpdateColor", async () => {
      const onUpdateColor = vi.fn();
      render(
        <ConfirmProvider>
          <ClassesPanel
            classes={fixture as any}
            onUpdateColor={onUpdateColor}
          />
        </ConfirmProvider>,
      );

      fireEvent.click(screen.getByTestId("class-color-swatch"));
      const customInput = (await screen.findByTestId(
        "class-color-custom",
      )) as HTMLInputElement;
      fireEvent.change(customInput, { target: { value: "#abcdef" } });

      expect(onUpdateColor).toHaveBeenCalledWith("c-1", "#abcdef");
    });
  });
});

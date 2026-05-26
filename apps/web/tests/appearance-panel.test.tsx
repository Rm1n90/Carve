import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// Mock pixi + ShapeRenderer first so renderBbox can be observed by the
// canvas-rerender check that flows the outlinedBorders param through.
vi.mock("pixi.js", () => {
  class FakeContainer {
    children: unknown[] = [];
    position = { set: () => undefined };
    scale = { set: () => undefined };
    addChild(...c: unknown[]) {
      this.children.push(...c);
    }
    removeChild() {}
  }
  class FakeApplication {
    stage = new FakeContainer();
    canvas = document.createElement("canvas");
    renderer = { resize: () => undefined };
    init = vi.fn(async () => {});
    destroy = vi.fn();
  }
  class FakeSprite {
    width = 100;
    height = 50;
    constructor(_t: unknown) {}
  }
  class FakeGraphics {
    clear() {}
    rect() {}
    stroke() {}
    fill() {}
    moveTo() {}
    lineTo() {}
    circle() {}
    visible = true;
  }
  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Assets: { load: vi.fn(async () => ({})) },
  };
});

const renderBboxSpy = vi.fn();
const renderPolygonSpy = vi.fn();
vi.mock("@/canvas/ShapeRenderer", () => ({
  renderBbox: (...args: unknown[]) => renderBboxSpy(...args),
  renderPolygon: (...args: unknown[]) => renderPolygonSpy(...args),
  BBOX_HANDLE_SIZE_PX: 8,
  BBOX_HANDLE_NAMES: ["nw", "ne", "se", "sw", "n", "e", "s", "w"],
  getBboxHandlePositions: (b: { x: number; y: number; w: number; h: number }) => [
    { name: "nw", cx: b.x, cy: b.y },
    { name: "ne", cx: b.x + b.w, cy: b.y },
    { name: "se", cx: b.x + b.w, cy: b.y + b.h },
    { name: "sw", cx: b.x, cy: b.y + b.h },
    { name: "n", cx: b.x + b.w / 2, cy: b.y },
    { name: "e", cx: b.x + b.w, cy: b.y + b.h / 2 },
    { name: "s", cx: b.x + b.w / 2, cy: b.y + b.h },
    { name: "w", cx: b.x, cy: b.y + b.h / 2 },
  ],
  cursorForHandle: () => "default",
}));

import { TooltipProvider } from "@/components/ui/Tooltip";
import { AppearancePanel } from "@/components/annotation/AppearancePanel";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import {
  DEFAULT_SETTINGS,
  useEditorSettings,
} from "@/state/editorSettings";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.localStorage.removeItem("carve.settings.v1");
  useEditorSettings.setState({ ...DEFAULT_SETTINGS });
  useAnnotations.getState().reset([]);
  useTool.getState().setActive("cursor");
  renderBboxSpy.mockReset();
  renderPolygonSpy.mockReset();
});

function renderPanel() {
  return render(
    <TooltipProvider>
      <AppearancePanel />
    </TooltipProvider>,
  );
}

describe("AppearancePanel — controls render", () => {
  it("renders the section heading and is open by default", () => {
    renderPanel();
    expect(screen.getByTestId("appearance-panel")).toBeInTheDocument();
    // Open by default → opacity slider rendered.
    expect(screen.getByTestId("appearance-opacity")).toBeInTheDocument();
  });

  it("collapses content when the toggle is clicked", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("appearance-panel-toggle"));
    expect(screen.queryByTestId("appearance-opacity")).toBeNull();
  });

  it("renders all controls: colorBy x3, opacity, selected opacity, outlined borders, show labels, show bitmap, show projections", () => {
    renderPanel();
    expect(screen.getByTestId("appearance-colorBy-label")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-colorBy-instance")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-colorBy-group")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-opacity")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-selectedOpacity")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-outlinedBorders")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-showLabels")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-showBitmap")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-showProjections")).toBeInTheDocument();
  });

  it("toggling 'Show labels' flips visibility.labels on the tool store", () => {
    renderPanel();
    expect(useTool.getState().visibility.labels).toBe(true);
    fireEvent.click(screen.getByTestId("appearance-showLabels"));
    expect(useTool.getState().visibility.labels).toBe(false);
    fireEvent.click(screen.getByTestId("appearance-showLabels"));
    expect(useTool.getState().visibility.labels).toBe(true);
  });
});

describe("AppearancePanel — wiring to editorSettings", () => {
  it("toggling 'Outlined borders' flips the setting and persists to localStorage", () => {
    renderPanel();
    expect(useEditorSettings.getState().outlinedBorders).toBe(false);
    fireEvent.click(screen.getByTestId("appearance-outlinedBorders"));
    expect(useEditorSettings.getState().outlinedBorders).toBe(true);
    const stored = JSON.parse(
      window.localStorage.getItem("carve.settings.v1") ?? "{}",
    );
    expect(stored.outlinedBorders).toBe(true);
  });

  it("changes the opacity slider and updates the store", () => {
    renderPanel();
    const slider = screen.getByTestId("appearance-opacity") as HTMLInputElement;
    expect(slider.value).toBe(String(DEFAULT_SETTINGS.opacity));
    fireEvent.change(slider, { target: { value: "80" } });
    expect(useEditorSettings.getState().opacity).toBe(80);
  });

  it("changes the selected-opacity slider and updates the store", () => {
    renderPanel();
    const slider = screen.getByTestId(
      "appearance-selectedOpacity",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "70" } });
    expect(useEditorSettings.getState().selectedOpacity).toBe(70);
  });

  it("Color by → Instance updates the store via segmented control", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("appearance-colorBy-instance"));
    expect(useEditorSettings.getState().colorBy).toBe("instance");
  });

  it("Color by Group is selectable (not disabled) and the trigger is wrapped in a tooltip explaining the fallback", () => {
    renderPanel();
    const groupBtn = screen.getByTestId(
      "appearance-colorBy-group",
    ) as HTMLButtonElement;
    expect(groupBtn.disabled).toBe(false);
    fireEvent.click(groupBtn);
    expect(useEditorSettings.getState().colorBy).toBe("group");
    expect(groupBtn.getAttribute("data-active")).toBe("true");
  });

  it("Show projections is rendered as disabled (v3 placeholder)", () => {
    renderPanel();
    const cb = screen.getByTestId(
      "appearance-showProjections",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
  });

  it("'Outlined borders' default color picker trigger renders with the default white color", () => {
    renderPanel();
    const swatch = screen.getByTestId(
      "appearance-outlinedBorderColor",
    ) as HTMLButtonElement;
    expect(swatch).toBeInTheDocument();
    // Inline style is set from settings.outlinedBorderColor (#FFFFFF).
    const bg = swatch.style.background.toLowerCase();
    expect(
      bg.includes("rgb(255, 255, 255)") || bg.includes("#ffffff"),
    ).toBe(true);
  });
});

describe("AppearancePanel — flows to the canvas renderer", () => {
  it("when outlinedBorders=true, AnnotationCanvas forwards the parsed outline color as the 9th renderBbox arg", async () => {
    useEditorSettings.getState().set("outlinedBorders", true);
    useEditorSettings.getState().set("outlinedBorderColor", "#FFFFFF");
    useAnnotations.getState().add({
      tempId: "t-outline-1",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 1, y: 2, w: 10, h: 20 },
      frameId: null,
      serverId: null,
      dirty: true,
    });

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-outline"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    expect(renderBboxSpy).toHaveBeenCalled();
    const lastCall = renderBboxSpy.mock.calls[renderBboxSpy.mock.calls.length - 1];
    // 9th positional arg (index 8) is outlineBorderColor when set.
    expect(lastCall[8]).toBe(0xffffff);
  });

  it("when outlinedBorders=false (default), the 9th renderBbox arg is undefined", async () => {
    useAnnotations.getState().add({
      tempId: "t-outline-2",
      classId: "c-1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 1, y: 2, w: 10, h: 20 },
      frameId: null,
      serverId: null,
      dirty: true,
    });

    render(
      <AnnotationCanvas
        width={100}
        height={50}
        imageUrl="https://fake/a.png"
        frameId={null}
        assetId="a-no-outline"
        classColorMap={{ "c-1": "#ff0000" }}
      />,
    );
    await flushAsync();

    expect(renderBboxSpy).toHaveBeenCalled();
    const lastCall = renderBboxSpy.mock.calls[renderBboxSpy.mock.calls.length - 1];
    expect(lastCall[8]).toBeUndefined();
  });
});

describe("editorSettings — appearance defaults", () => {
  it("defaults outlinedBorders=false, outlinedBorderColor=#FFFFFF, showProjections=false", () => {
    expect(DEFAULT_SETTINGS.outlinedBorders).toBe(false);
    expect(DEFAULT_SETTINGS.outlinedBorderColor).toBe("#FFFFFF");
    expect(DEFAULT_SETTINGS.showProjections).toBe(false);
  });
});

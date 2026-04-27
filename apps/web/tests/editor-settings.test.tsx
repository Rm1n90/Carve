import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { EditorSettingsDialog } from "@/components/annotation/EditorSettingsDialog";
import {
  DEFAULT_SETTINGS,
  useEditorSettings,
} from "@/state/editorSettings";

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  // Always start each test with the defaults applied to localStorage and
  // the live store so previous-test state doesn't leak between tests.
  window.localStorage.removeItem("carve.settings.v1");
  useEditorSettings.setState({ ...DEFAULT_SETTINGS });
});

describe("EditorSettingsDialog", () => {
  it("does not render content when open=false", () => {
    render(<EditorSettingsDialog open={false} onOpenChange={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders both tabs when open=true", async () => {
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    // Player tab is the default selection.
    expect(await screen.findByTestId("tab-player")).toBeInTheDocument();
    expect(screen.getByTestId("tab-workspace")).toBeInTheDocument();
    // Player-tab specific control is visible by default.
    expect(screen.getByTestId("setting-playerStep")).toBeInTheDocument();
  });

  it("switches to the Workspace tab when its trigger is clicked", async () => {
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    const ws = await screen.findByTestId("tab-workspace");
    fireEvent.click(ws);
    expect(
      await screen.findByTestId("setting-autoSaveIntervalSeconds"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("setting-opacity")).toBeInTheDocument();
  });

  it("updates auto-save interval and persists it to localStorage", async () => {
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    const ws = await screen.findByTestId("tab-workspace");
    fireEvent.click(ws);
    const input = (await screen.findByTestId(
      "setting-autoSaveIntervalSeconds",
    )) as HTMLInputElement;
    expect(input.value).toBe("1.5");
    fireEvent.change(input, { target: { value: "5" } });
    expect(useEditorSettings.getState().autoSaveIntervalSeconds).toBe(5);
    const stored = JSON.parse(
      window.localStorage.getItem("carve.settings.v1") ?? "{}",
    );
    expect(stored.autoSaveIntervalSeconds).toBe(5);
  });

  it("updates opacity and persists it to localStorage", async () => {
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    const ws = await screen.findByTestId("tab-workspace");
    fireEvent.click(ws);
    const slider = (await screen.findByTestId("setting-opacity")) as HTMLInputElement;
    // Default opacity is sourced from DEFAULT_SETTINGS so the test tracks
    // changes (Phase B v2.4 lowered the default fill alpha to be subtler).
    expect(slider.value).toBe(String(DEFAULT_SETTINGS.opacity));
    fireEvent.change(slider, { target: { value: "80" } });
    expect(useEditorSettings.getState().opacity).toBe(80);
    const stored = JSON.parse(
      window.localStorage.getItem("carve.settings.v1") ?? "{}",
    );
    expect(stored.opacity).toBe(80);
  });

  it("hydrates from prior store state on render", () => {
    useEditorSettings.setState({
      ...DEFAULT_SETTINGS,
      opacity: 65,
      autoSaveIntervalSeconds: 3,
    });
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByTestId("tab-workspace"));
    const slider = screen.getByTestId("setting-opacity") as HTMLInputElement;
    expect(slider.value).toBe("65");
    const interval = screen.getByTestId(
      "setting-autoSaveIntervalSeconds",
    ) as HTMLInputElement;
    expect(interval.value).toBe("3");
  });

  it("Reset to defaults restores defaults", async () => {
    useEditorSettings.setState({ ...DEFAULT_SETTINGS, opacity: 80 });
    render(<EditorSettingsDialog open onOpenChange={() => undefined} />);
    fireEvent.click(await screen.findByTestId("settings-reset"));
    expect(useEditorSettings.getState().opacity).toBe(
      DEFAULT_SETTINGS.opacity,
    );
  });
});

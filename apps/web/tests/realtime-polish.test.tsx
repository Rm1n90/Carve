// Armin Mehri — mehri.armin@gmail.com
/**
 * Phase 7 polish tests:
 *   * Connection-status banner: visible at the right state
 *     transitions, hidden during happy-path.
 *   * Focus halo overlay: renders one ring per other user with focus
 *     on a *known* annotation; ignores focus on unknown ids.
 *   * Cursor layer respects the ``hideCollaborators`` setting (short-
 *     circuits to null without touching the inbound store).
 *   * AppearancePanel exposes the toggle and writes back to settings.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/Tooltip";
import { AppearancePanel } from "@/components/annotation/AppearancePanel";
import { PresenceConnectionStatus } from "@/components/annotation/PresenceConnectionStatus";
import {
  PresenceCursorLayer,
  type CanvasTransform,
} from "@/components/annotation/PresenceCursorLayer";
import { PresenceFocusLayer } from "@/components/annotation/PresenceFocusLayer";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import { usePresence } from "@/realtime/presence";
import { DEFAULT_SETTINGS, useEditorSettings } from "@/state/editorSettings";
import { useAnnotations } from "@/state/annotations";

const IDENTITY_TRANSFORM: CanvasTransform = {
  scale: 1,
  offset: { x: 0, y: 0 },
};

function presenceUser(overrides: Partial<{
  session_id: string;
  name: string;
  color: string;
  focus: { kind: "annotation"; id: string } | null;
  cursor: {
    asset_id: string;
    frame_id: string | null;
    x: number;
    y: number;
    updated_at: number;
  } | null;
}> = {}) {
  return {
    user_id: "11111111-1111-1111-1111-111111111111",
    session_id: overrides.session_id ?? "s-other",
    name: overrides.name ?? "alice",
    color: overrides.color ?? "#34d399",
    cursor: overrides.cursor ?? null,
    focus: overrides.focus ?? null,
  };
}

beforeEach(() => {
  window.localStorage.removeItem("carve.settings.v1");
  useEditorSettings.setState({ ...DEFAULT_SETTINGS });
  useConnectionStatus.getState().reset();
  usePresence.getState().reset();
  useAnnotations.getState().reset([]);
  cleanup();
});

// ---- Connection status banner ---------------------------------------------

describe("PresenceConnectionStatus", () => {
  it("renders nothing when idle (pre-mount)", () => {
    render(<PresenceConnectionStatus />);
    expect(screen.queryByTestId("presence-connection-status")).toBeNull();
  });

  it("renders nothing when connected (happy path keeps the bar clean)", () => {
    useConnectionStatus.setState({ status: "connected" });
    render(<PresenceConnectionStatus />);
    expect(screen.queryByTestId("presence-connection-status")).toBeNull();
  });

  it("shows Connecting… on first connect", () => {
    useConnectionStatus.setState({ status: "connecting" });
    render(<PresenceConnectionStatus />);
    const el = screen.getByTestId("presence-connection-status");
    expect(el.getAttribute("data-state")).toBe("connecting");
    expect(el.textContent).toContain("Connecting");
  });

  it("shows Reconnecting (attempt N)… after the first failure", () => {
    useConnectionStatus.setState({
      status: "reconnecting",
      reconnectAttempt: 3,
    });
    render(<PresenceConnectionStatus />);
    const el = screen.getByTestId("presence-connection-status");
    expect(el.textContent).toContain("attempt 3");
  });

  it("shows a tailored copy on invalid_ticket disconnects", () => {
    useConnectionStatus.setState({
      status: "disconnected",
      lastError: "invalid_ticket",
    });
    render(<PresenceConnectionStatus />);
    const el = screen.getByTestId("presence-connection-status");
    expect(el.textContent).toContain("refresh");
  });
});

// ---- Focus halo overlay ---------------------------------------------------

describe("PresenceFocusLayer", () => {
  it("renders nothing when no presence entry has focus", () => {
    render(<PresenceFocusLayer transform={IDENTITY_TRANSFORM} />);
    expect(screen.queryByTestId("presence-focus-layer")).toBeNull();
  });

  it("renders a ring for a focused bbox when the annotation is known", () => {
    const annId = "ann-aaa";
    useAnnotations.getState().add({
      tempId: annId,
      classId: "c1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 10, y: 20, w: 100, h: 50 },
      frameId: null,
      serverId: annId,
      dirty: false,
    });
    usePresence.getState().applyJoin(
      presenceUser({
        session_id: "s-1",
        focus: { kind: "annotation", id: annId },
      }),
    );
    render(<PresenceFocusLayer transform={IDENTITY_TRANSFORM} />);
    expect(screen.getByTestId("presence-focus-layer")).toBeInTheDocument();
    expect(screen.getByTestId("presence-focus-s-1")).toBeInTheDocument();
    expect(screen.getByTestId("presence-focus-s-1").textContent).toContain(
      "is editing",
    );
  });

  it("skips users whose focus points at an unknown annotation id", () => {
    usePresence.getState().applyJoin(
      presenceUser({
        session_id: "s-1",
        focus: { kind: "annotation", id: "does-not-exist" },
      }),
    );
    render(<PresenceFocusLayer transform={IDENTITY_TRANSFORM} />);
    expect(screen.queryByTestId("presence-focus-layer")).toBeNull();
  });

  it("filters out the local tab", () => {
    const annId = "ann-bbb";
    useAnnotations.getState().add({
      tempId: annId,
      classId: "c1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 1, y: 1, w: 2, h: 2 },
      frameId: null,
      serverId: annId,
      dirty: false,
    });
    useConnectionStatus.setState({ currentSessionId: "self" });
    usePresence.getState().applyJoin(
      presenceUser({
        session_id: "self",
        focus: { kind: "annotation", id: annId },
      }),
    );
    render(<PresenceFocusLayer transform={IDENTITY_TRANSFORM} />);
    expect(screen.queryByTestId("presence-focus-layer")).toBeNull();
  });
});

// ---- Cursor layer + setting -----------------------------------------------

describe("PresenceCursorLayer + hideCollaborators", () => {
  it("renders cursors by default", () => {
    usePresence.getState().applyJoin(
      presenceUser({
        session_id: "s-1",
        cursor: {
          asset_id: "a",
          frame_id: null,
          x: 5,
          y: 5,
          updated_at: Date.now(),
        },
      }),
    );
    render(
      <PresenceCursorLayer transform={IDENTITY_TRANSFORM} assetId="a" />,
    );
    expect(screen.getByTestId("presence-cursor-layer")).toBeInTheDocument();
    expect(screen.getByTestId("presence-cursor-s-1")).toBeInTheDocument();
  });

  it("renders nothing when hideCollaborators is set", () => {
    useEditorSettings.getState().set("hideCollaborators", true);
    usePresence.getState().applyJoin(
      presenceUser({
        session_id: "s-1",
        cursor: {
          asset_id: "a",
          frame_id: null,
          x: 5,
          y: 5,
          updated_at: Date.now(),
        },
      }),
    );
    render(
      <PresenceCursorLayer transform={IDENTITY_TRANSFORM} assetId="a" />,
    );
    expect(screen.queryByTestId("presence-cursor-layer")).toBeNull();
  });
});

// ---- AppearancePanel toggle wiring ----------------------------------------

describe("AppearancePanel — Show collaborators toggle", () => {
  function renderPanel() {
    return render(
      <TooltipProvider>
        <AppearancePanel />
      </TooltipProvider>,
    );
  }

  it("is checked by default (collaborators visible)", () => {
    renderPanel();
    const cb = screen.getByTestId("appearance-showCollaborators") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(useEditorSettings.getState().hideCollaborators).toBe(false);
  });

  it("toggling off flips the underlying setting to true", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("appearance-showCollaborators"));
    expect(useEditorSettings.getState().hideCollaborators).toBe(true);
  });

  it("persists the toggle to localStorage", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("appearance-showCollaborators"));
    const stored = JSON.parse(
      window.localStorage.getItem("carve.settings.v1") ?? "{}",
    );
    expect(stored.hideCollaborators).toBe(true);
  });
});

// Armin Mehri — mehri.armin@gmail.com
/**
 * Tests for the frontend presence layer:
 *   * ``usePresence`` Zustand store actions
 *   * ``applyPresence`` handlers (bridge between WS envelopes and store)
 *   * ``PresenceChips`` component — render shape + self-filter
 *
 * No network; we drive the store directly and assert observable
 * state. The PresenceCursorLayer's rendering depends on a live
 * transform + setInterval ticks — covered better by E2E than unit, so
 * not exercised here.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import {
  handleHelloPresence,
  handlePresenceCursor,
  handlePresenceFocus,
  handlePresenceJoin,
  handlePresenceLeave,
} from "@/realtime/applyPresence";
import {
  PRESENCE_PALETTE,
  _resetColorCacheForTest,
  colorForUser,
  usePresence,
} from "@/realtime/presence";
import { PROTOCOL_VERSION } from "@/realtime/types";
import { PresenceChips } from "@/components/annotation/PresenceChips";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import { TooltipProvider } from "@/components/ui/Tooltip";

// ---- helpers ---------------------------------------------------------------

function mkUser(overrides: Partial<{
  user_id: string;
  session_id: string;
  name: string;
  color: string;
}> = {}) {
  return {
    user_id:
      overrides.user_id ?? "11111111-1111-1111-1111-111111111111",
    session_id:
      overrides.session_id ?? "22222222-2222-2222-2222-222222222222",
    name: overrides.name ?? "alice",
    color: overrides.color ?? "#34d399",
    cursor: null,
    focus: null,
  };
}

beforeEach(() => {
  usePresence.getState().reset();
  useConnectionStatus.getState().reset();
  _resetColorCacheForTest();
  cleanup();
});

// ---- color helper ----------------------------------------------------------

describe("colorForUser", () => {
  it("is deterministic for a given user_id (across calls within a session)", () => {
    const id = "33333333-3333-3333-3333-333333333333";
    const a = colorForUser(id);
    const b = colorForUser(id);
    expect(a).toBe(b);
  });

  it("returns a palette entry for any well-formed UUID", () => {
    const c = colorForUser("44444444-4444-4444-4444-444444444444");
    expect(PRESENCE_PALETTE.some((p) => p === c)).toBe(true);
  });

  it("falls back to a stable palette pick for malformed ids", () => {
    // Defensive: a non-UUID input should still return *something* in
    // the palette rather than throwing or returning undefined.
    const c = colorForUser("not-a-uuid");
    expect(PRESENCE_PALETTE.some((p) => p === c)).toBe(true);
  });
});

// ---- store actions ---------------------------------------------------------

describe("usePresence", () => {
  it("applyHelloPresence seeds the map from the snapshot", () => {
    const users = [
      mkUser({ session_id: "s1", name: "alice" }),
      mkUser({ session_id: "s2", name: "bob" }),
    ];
    usePresence.getState().applyHelloPresence(users);
    const state = usePresence.getState().bySession;
    expect(Object.keys(state).sort()).toEqual(["s1", "s2"]);
    expect(state["s1"]?.name).toBe("alice");
    expect(state["s2"]?.name).toBe("bob");
  });

  it("applyHelloPresence replaces the entire prior state (no stale rows)", () => {
    usePresence.getState().applyJoin(mkUser({ session_id: "old" }));
    expect(usePresence.getState().bySession.old).toBeDefined();
    usePresence.getState().applyHelloPresence([mkUser({ session_id: "new" })]);
    expect(usePresence.getState().bySession.old).toBeUndefined();
    expect(usePresence.getState().bySession.new).toBeDefined();
  });

  it("applyJoin adds a user and applyLeave removes by session_id", () => {
    usePresence.getState().applyJoin(mkUser({ session_id: "s1" }));
    expect(Object.keys(usePresence.getState().bySession)).toEqual(["s1"]);
    usePresence.getState().applyLeave("s1");
    expect(Object.keys(usePresence.getState().bySession)).toEqual([]);
  });

  it("applyCursor updates an existing entry only", () => {
    usePresence.getState().applyJoin(mkUser({ session_id: "s1" }));
    usePresence.getState().applyCursor({
      session_id: "s1",
      user_id: "u1",
      asset_id: "a1",
      frame_id: null,
      x: 12,
      y: 34,
    });
    const c = usePresence.getState().bySession.s1?.cursor;
    expect(c?.x).toBe(12);
    expect(c?.y).toBe(34);
    expect(c?.asset_id).toBe("a1");
  });

  it("applyCursor for an unknown session is a no-op (no rogue rows)", () => {
    usePresence.getState().applyCursor({
      session_id: "missing",
      user_id: "u",
      asset_id: "a",
      frame_id: null,
      x: 1,
      y: 1,
    });
    expect(Object.keys(usePresence.getState().bySession)).toEqual([]);
  });

  it("applyFocus updates the target and null clears it", () => {
    usePresence.getState().applyJoin(mkUser({ session_id: "s1" }));
    usePresence.getState().applyFocus({
      session_id: "s1",
      user_id: "u1",
      target: { kind: "annotation", id: "abc" },
    });
    expect(usePresence.getState().bySession.s1?.focus).toEqual({
      kind: "annotation",
      id: "abc",
    });
    usePresence.getState().applyFocus({
      session_id: "s1",
      user_id: "u1",
      target: null,
    });
    expect(usePresence.getState().bySession.s1?.focus).toBeNull();
  });

  it("reset clears everything", () => {
    usePresence.getState().applyJoin(mkUser());
    usePresence.getState().reset();
    expect(usePresence.getState().bySession).toEqual({});
  });
});

// ---- applyPresence handlers ------------------------------------------------

describe("applyPresence handlers", () => {
  it("handleHelloPresence forwards the snapshot to the store", () => {
    handleHelloPresence({
      v: PROTOCOL_VERSION,
      type: "hello",
      session_id: "self",
      user_id: "self-uid",
      task_id: "task",
      server_time: 0,
      last_event_seq: 0,
      presence: [
        {
          user_id: "u-alice",
          session_id: "alice-1",
          name: "alice",
          color: "#34d399",
        },
      ],
    });
    expect(usePresence.getState().bySession["alice-1"]?.name).toBe("alice");
  });

  it("handlePresenceJoin adds the new user", () => {
    handlePresenceJoin({
      v: PROTOCOL_VERSION,
      type: "presence:join",
      user: {
        user_id: "u-bob",
        session_id: "bob-1",
        name: "bob",
        color: "#fbbf24",
      },
    });
    expect(usePresence.getState().bySession["bob-1"]?.color).toBe("#fbbf24");
  });

  it("handlePresenceLeave removes by session", () => {
    handlePresenceJoin({
      v: PROTOCOL_VERSION,
      type: "presence:join",
      user: {
        user_id: "u",
        session_id: "s",
        name: "x",
        color: "#ff0000",
      },
    });
    handlePresenceLeave({
      v: PROTOCOL_VERSION,
      type: "presence:leave",
      session_id: "s",
      user_id: "u",
    });
    expect(usePresence.getState().bySession.s).toBeUndefined();
  });

  it("handlePresenceCursor stamps updated_at into the store", () => {
    handlePresenceJoin({
      v: PROTOCOL_VERSION,
      type: "presence:join",
      user: { user_id: "u", session_id: "s", name: "x", color: "#ff0000" },
    });
    handlePresenceCursor({
      v: PROTOCOL_VERSION,
      type: "presence:cursor",
      session_id: "s",
      user_id: "u",
      asset_id: "a",
      frame_id: null,
      x: 5,
      y: 7,
    });
    const cur = usePresence.getState().bySession.s?.cursor;
    expect(cur?.x).toBe(5);
    expect(cur?.y).toBe(7);
    expect(typeof cur?.updated_at).toBe("number");
  });

  it("handlePresenceFocus mirrors the target onto the store", () => {
    handlePresenceJoin({
      v: PROTOCOL_VERSION,
      type: "presence:join",
      user: { user_id: "u", session_id: "s", name: "x", color: "#ff0000" },
    });
    handlePresenceFocus({
      v: PROTOCOL_VERSION,
      type: "presence:focus",
      session_id: "s",
      user_id: "u",
      target: { kind: "annotation", id: "ann-123" },
    });
    expect(usePresence.getState().bySession.s?.focus).toEqual({
      kind: "annotation",
      id: "ann-123",
    });
  });
});

// ---- PresenceChips ---------------------------------------------------------

function renderChips() {
  return render(
    <TooltipProvider>
      <PresenceChips />
    </TooltipProvider>,
  );
}

describe("PresenceChips", () => {
  it("returns null when the store is empty", () => {
    renderChips();
    expect(screen.queryByTestId("presence-chips")).toBeNull();
  });

  it("renders a chip for every other user", () => {
    usePresence.getState().applyHelloPresence([
      mkUser({ session_id: "s1", name: "alice", color: "#34d399" }),
      mkUser({ session_id: "s2", name: "bob", color: "#60a5fa" }),
    ]);
    renderChips();
    expect(screen.getByTestId("presence-chips")).toBeInTheDocument();
    expect(screen.getByTestId("presence-chip-s1")).toBeInTheDocument();
    expect(screen.getByTestId("presence-chip-s2")).toBeInTheDocument();
  });

  it("filters out the local tab via currentSessionId", () => {
    useConnectionStatus.setState({ currentSessionId: "self" });
    usePresence.getState().applyHelloPresence([
      mkUser({ session_id: "self", name: "me" }),
      mkUser({ session_id: "other", name: "alice" }),
    ]);
    renderChips();
    expect(screen.queryByTestId("presence-chip-self")).toBeNull();
    expect(screen.getByTestId("presence-chip-other")).toBeInTheDocument();
  });

  it("uses the user's first initial inside the chip", () => {
    usePresence.getState().applyHelloPresence([
      mkUser({ session_id: "s1", name: "alice" }),
    ]);
    renderChips();
    const chip = screen.getByTestId("presence-chip-s1");
    expect(chip.textContent).toBe("A");
  });
});

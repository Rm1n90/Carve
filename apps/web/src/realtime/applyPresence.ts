// Armin Mehri — mehri.armin@gmail.com
/**
 * Bridge between the transport (``ws.ts``) and the
 * :func:`usePresence` Zustand store.
 *
 * Each handler is a pure function over a typed envelope — same shape
 * as ``applyOps.ts`` for annotation events. Mounted from
 * :func:`useTaskStream` so the store stays in sync with the WS.
 */

import { colorForUser, usePresence } from "@/realtime/presence";
import type {
  ServerHello,
  ServerPresenceCursor,
  ServerPresenceFocus,
  ServerPresenceJoin,
  ServerPresenceLeave,
  PresenceUser as ServerPresenceUserField,
} from "@/realtime/types";

/**
 * Seed the store from ``hello.presence``. ``hello`` arrives once per
 * connect; the snapshot replaces any stale state from a prior session.
 */
export function handleHelloPresence(msg: ServerHello): void {
  usePresence.getState().applyHelloPresence(
    msg.presence.map((u: ServerPresenceUserField) => ({
      user_id: u.user_id,
      session_id: u.session_id,
      name: u.name,
      // Trust the server's color when present, fall back to the local
      // hash if missing (forward-compat).
      color: u.color || colorForUser(u.user_id),
      cursor: null,
      focus: null,
    })),
  );
}

export function handlePresenceJoin(msg: ServerPresenceJoin): void {
  usePresence.getState().applyJoin({
    user_id: msg.user.user_id,
    session_id: msg.user.session_id,
    name: msg.user.name,
    color: msg.user.color || colorForUser(msg.user.user_id),
    cursor: null,
    focus: null,
  });
}

export function handlePresenceLeave(msg: ServerPresenceLeave): void {
  usePresence.getState().applyLeave(msg.session_id);
}

export function handlePresenceCursor(msg: ServerPresenceCursor): void {
  usePresence.getState().applyCursor({
    session_id: msg.session_id,
    user_id: msg.user_id,
    asset_id: msg.asset_id,
    frame_id: msg.frame_id ?? null,
    x: msg.x,
    y: msg.y,
  });
}

export function handlePresenceFocus(msg: ServerPresenceFocus): void {
  usePresence.getState().applyFocus({
    session_id: msg.session_id,
    user_id: msg.user_id,
    target: msg.target,
  });
}

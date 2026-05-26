// Armin Mehri — mehri.armin@gmail.com
/**
 * Zustand store tracking the WebSocket connection lifecycle.
 *
 * Two consumers share this state:
 *
 *   * The transport (``ws.ts``) writes status transitions and bumps
 *     ``lastEventSeq`` on every ops/resync envelope.
 *   * The axios layer (Phase 4) reads ``currentSessionId`` to attach
 *     the ``X-Origin-Session`` header on mutating requests — that's
 *     how the server identifies which tab to skip when echoing the
 *     broadcast back.
 *
 * Why a Zustand store and not a React context: status updates can
 * happen outside React (e.g. inside the WS event handler), and we
 * need axios — which is not a React tree component — to read the
 * current session id synchronously. Zustand handles both.
 */

import { create } from "zustand";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

interface ConnectionStatusState {
  /** Current lifecycle state. ``idle`` until the first connect attempt. */
  status: ConnectionStatus;
  /** The server-assigned session id from the most recent ``hello``.
   *  Cleared on disconnect. Phase 4 reads this for ``X-Origin-Session``. */
  currentSessionId: string | null;
  /** Highest envelope ``seq`` this client has *received* (after any
   *  client-side dedupe filter). The transport sends this back as
   *  ``?last_event_seq=`` on the next reconnect so the bus can replay
   *  buffered events. */
  lastEventSeq: number;
  /** Most recent error string, if any. Cleared on successful connect. */
  lastError: string | null;
  /** Number of reconnect attempts since the last successful connect.
   *  Used by the UI (Phase 7) to surface "Reconnecting…" + attempt
   *  count, and by the transport to compute the back-off delay. */
  reconnectAttempt: number;

  // ---- Actions --------------------------------------------------------

  setStatus(status: ConnectionStatus): void;
  /** Called from the transport on ``hello``. Resets reconnect attempt
   *  counter and error, captures the server session id, and only
   *  *advances* lastEventSeq (never rewinds — the server may send a
   *  smaller seq during a cold-start hello and we don't want that to
   *  re-replay events we already have). */
  applyHello(args: { sessionId: string; lastEventSeq: number }): void;
  /** Advance ``lastEventSeq`` to ``seq`` if it's strictly greater than
   *  the current value. Idempotent: re-deliveries of the same seq do
   *  not bump the watermark. */
  bumpSeq(seq: number): void;
  setError(message: string | null): void;
  incrementReconnectAttempt(): void;
  /** Full reset (e.g. user switches task or logs out). */
  reset(): void;
}

const INITIAL: Omit<
  ConnectionStatusState,
  | "setStatus"
  | "applyHello"
  | "bumpSeq"
  | "setError"
  | "incrementReconnectAttempt"
  | "reset"
> = {
  status: "idle",
  currentSessionId: null,
  lastEventSeq: 0,
  lastError: null,
  reconnectAttempt: 0,
};

export const useConnectionStatus = create<ConnectionStatusState>((set) => ({
  ...INITIAL,

  setStatus: (status) => set({ status }),

  applyHello: ({ sessionId, lastEventSeq }) =>
    set((s) => ({
      status: "connected",
      currentSessionId: sessionId,
      lastError: null,
      reconnectAttempt: 0,
      // Never rewind the watermark — a cold-start hello may report a
      // value lower than what this client has already applied via a
      // previous session.
      lastEventSeq: Math.max(s.lastEventSeq, lastEventSeq),
    })),

  bumpSeq: (seq) =>
    set((s) => (seq > s.lastEventSeq ? { lastEventSeq: seq } : s)),

  setError: (message) => set({ lastError: message }),

  incrementReconnectAttempt: () =>
    set((s) => ({ reconnectAttempt: s.reconnectAttempt + 1 })),

  reset: () => set({ ...INITIAL }),
}));

/**
 * Cheap, side-effect-free accessor for non-React callers (axios
 * interceptors, telemetry, etc.). Returns the value Phase 4 attaches
 * to the ``X-Origin-Session`` header on mutating REST calls, or
 * ``null`` if the WS is not currently connected.
 */
export function getCurrentSessionId(): string | null {
  return useConnectionStatus.getState().currentSessionId;
}

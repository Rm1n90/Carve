// Armin Mehri — mehri.armin@gmail.com
/**
 * WebSocket transport for the realtime collaboration channel.
 *
 * Responsibilities:
 *
 *   * Fetch a one-time ticket via REST and open a WS to
 *     ``/realtime/ws/{task_id}?ticket=…&last_event_seq=N``.
 *   * Parse inbound frames and dispatch them to phase-specific
 *     callbacks (``onHello`` / ``onOps`` / ``onResync`` / ``onError``).
 *   * Maintain the :mod:`connectionStatus` store as the single source
 *     of truth for the connection lifecycle.
 *   * Auto-reconnect with exponential back-off + jitter on close /
 *     network error. ``last_event_seq`` is sent every time so the
 *     server can replay events the client missed.
 *   * Heartbeat: send ``ping`` every 25 s; if no ``pong`` within 10 s,
 *     force-close the socket and let the reconnect path take over —
 *     covers proxy / NAT idle drops where the TCP connection has
 *     silently died but the browser doesn't surface a ``close`` event
 *     yet.
 *
 * What this layer does *not* do:
 *
 *   * Apply ops to the local store — Phase 4 attaches an ``onOps``
 *     callback that updates ``useAnnotations``.
 *   * Surface UI state (toasts, banners) — Phase 7 reads the
 *     connection-status store directly.
 *   * Track presence — Phase 5/6.
 */

import { fetchRealtimeTicket } from "@/api/realtime";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerError,
  type ServerHello,
  type ServerMessage,
  type ServerOpsBatch,
  type ServerOpsDelete,
  type ServerOpsUpsert,
  type ServerPresenceCursor,
  type ServerPresenceFocus,
  type ServerPresenceJoin,
  type ServerPresenceLeave,
  type ServerResync,
  type ServerUnknown,
} from "@/realtime/types";

export type PresenceEnvelope =
  | ServerPresenceJoin
  | ServerPresenceLeave
  | ServerPresenceCursor
  | ServerPresenceFocus;

// -------- Configuration ------------------------------------------------------

/** Minimum delay before the first reconnect attempt, in ms. Doubled on
 *  each consecutive failure and capped at :data:`RECONNECT_MAX_DELAY_MS`. */
export const RECONNECT_MIN_DELAY_MS = 500;
/** Hard ceiling for reconnect back-off. 30 s matches the server's
 *  request-timeout window so failures are surfaced quickly. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** Heartbeat ping cadence. Picked well below the ~60 s default idle
 *  timeout most reverse proxies enforce. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** Maximum time to wait for a pong after sending a ping. Crossing
 *  this threshold force-closes the WS and triggers reconnect. */
export const PONG_TIMEOUT_MS = 10_000;

// -------- Callback contracts -------------------------------------------------

export interface RealtimeCallbacks {
  /** Fired once per successful connect with the server-allocated
   *  session id + watermark. The store has already been updated by
   *  the time this fires. */
  onHello?: (msg: ServerHello) => void;
  /** Fired for every data-sync envelope. Phase 4 wires the
   *  apply-to-store consumer. */
  onOps?: (msg: ServerOpsUpsert | ServerOpsDelete | ServerOpsBatch) => void;
  /** Fired when the server requests a full resync (replay gap, etc.).
   *  Phase 4 invalidates react-query caches in response. */
  onResync?: (msg: ServerResync) => void;
  /** Fired for structured error envelopes. Does NOT close the
   *  connection — the server stays alive across protocol mismatches. */
  onError?: (msg: ServerError) => void;
  /** Fired for ``type`` values this client doesn't recognise (e.g.
   *  newer server version). Telemetry hook for forward-compat. */
  onUnknown?: (msg: ServerUnknown) => void;
  /** Phase 6 — fired for every ``presence:*`` envelope. Consumer
   *  switches on ``msg.type`` and forwards to the matching store
   *  handler in ``applyPresence.ts``. One callback (rather than four
   *  typed ones) keeps the public surface small. */
  onPresence?: (msg: PresenceEnvelope) => void;
}

export interface RealtimeClientOptions extends RealtimeCallbacks {
  /** Task whose channel to subscribe to. */
  taskId: string;
  /** Override the API base URL used to derive the WS URL. Defaults to
   *  ``VITE_API_BASE`` (falling back to ``/api``). Mainly here for
   *  tests. */
  baseUrl?: string;
  /** Override the ticket-fetch implementation. Tests inject a fake. */
  ticketFetcher?: (taskId: string) => Promise<string>;
  /** Override the WebSocket constructor. Tests inject a mock so they
   *  can synchronously trigger ``onmessage`` / ``onclose``. */
  webSocketImpl?: typeof WebSocket;
}

// -------- Helpers ------------------------------------------------------------

function defaultBaseUrl(): string {
  // ``import.meta.env`` is bundled by Vite; for vitest under jsdom it's
  // still defined. Guard against environments without it (e.g. a
  // future SSR pass) by falling back to ``/api``.
  const env = (import.meta as { env?: Record<string, string> }).env;
  return env?.VITE_API_BASE ?? "/api";
}

/**
 * Convert an HTTP base URL into a ws / wss URL.
 *
 * Three input shapes are supported:
 *
 *   * ``"/api"`` — relative. Scheme + host come from
 *     ``window.location``.
 *   * ``"http://host:port/api"`` / ``"https://host/api"`` — absolute.
 *     ``http`` swaps to ``ws``; ``https`` swaps to ``wss``.
 */
export function toWebSocketBaseUrl(base: string): string {
  if (base.startsWith("/")) {
    const scheme =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "wss:"
        : "ws:";
    const host =
      typeof window !== "undefined" ? window.location.host : "localhost";
    return `${scheme}//${host}${base.replace(/\/$/, "")}`;
  }
  return base.replace(/^http/, "ws").replace(/\/$/, "");
}

export function buildWebSocketUrl(args: {
  base: string;
  taskId: string;
  ticket: string;
  lastEventSeq: number;
}): string {
  const root = toWebSocketBaseUrl(args.base);
  const url = new URL(`${root}/realtime/ws/${encodeURIComponent(args.taskId)}`);
  url.searchParams.set("ticket", args.ticket);
  if (args.lastEventSeq > 0) {
    url.searchParams.set("last_event_seq", String(args.lastEventSeq));
  }
  return url.toString();
}

/**
 * Exponential back-off with ±25 % jitter, capped at
 * :data:`RECONNECT_MAX_DELAY_MS`. Attempt 0 returns the first delay
 * after the initial failure.
 */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(
    RECONNECT_MIN_DELAY_MS * 2 ** attempt,
    RECONNECT_MAX_DELAY_MS,
  );
  // ±25 % jitter avoids thundering-herd reconnects from a fleet of
  // tabs that all dropped at the same instant (e.g. backend restart).
  const jittered = base * (0.75 + Math.random() * 0.5);
  return Math.min(jittered, RECONNECT_MAX_DELAY_MS);
}

// -------- Client -------------------------------------------------------------

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongWatchdog: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Locked once :func:`stop` is called so an in-flight reconnect
   *  doesn't open a fresh socket post-unmount. */
  private stopped = false;

  constructor(private readonly options: RealtimeClientOptions) {}

  /** Begin the connect / reconnect cycle. Idempotent — calling twice
   *  is a no-op if a connect is already in flight. */
  async start(): Promise<void> {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.ws || this.reconnectTimer) {
      return;
    }
    await this.connect();
  }

  /** Permanently close. Cancels any pending reconnect and lets the
   *  socket flush whatever's queued. After this the instance is
   *  effectively dead — call ``start()`` again to reuse. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, "client_stop");
      } catch {
        /* socket may already be closed */
      }
      this.ws = null;
    }
    // Clear the session id so axios mutations during the disconnected
    // window don't echo a stale value.
    useConnectionStatus.setState({
      status: "disconnected",
      currentSessionId: null,
    });
  }

  /** Send a typed client message. Drops the message if the socket
   *  isn't open — callers should treat send as best-effort and rely
   *  on reconnect + replay for durability. */
  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* socket may have died mid-send; reconnect will pick this up */
    }
  }

  // ---- internals ----------------------------------------------------

  private async connect(): Promise<void> {
    const status = useConnectionStatus.getState();
    const isReconnect = status.status !== "idle";
    useConnectionStatus
      .getState()
      .setStatus(isReconnect ? "reconnecting" : "connecting");

    let ticket: string;
    try {
      const fetcher =
        this.options.ticketFetcher ??
        (async (taskId: string) =>
          (await fetchRealtimeTicket(taskId)).ticket);
      ticket = await fetcher(this.options.taskId);
    } catch (error: unknown) {
      this.handleFatalConnectError(error, "ticket_fetch_failed");
      return;
    }

    if (this.stopped) {
      // start() was raced by stop() during the ticket fetch.
      return;
    }

    const base = this.options.baseUrl ?? defaultBaseUrl();
    const url = buildWebSocketUrl({
      base,
      taskId: this.options.taskId,
      ticket,
      lastEventSeq: useConnectionStatus.getState().lastEventSeq,
    });

    const Ctor = this.options.webSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Ctor(url);
    } catch (error: unknown) {
      this.handleFatalConnectError(error, "ws_construct_failed");
      return;
    }

    this.ws = ws;
    ws.onopen = () => {
      // Don't transition to connected here — wait for hello so the
      // store has a session id before any consumer reads it.
    };
    ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    ws.onerror = () => {
      // The browser will follow up with a close event; record the
      // error message there so we don't double-fire.
      useConnectionStatus.getState().setError("websocket_error");
    };
    ws.onclose = (ev) => this.handleClose(ev.code, ev.reason);
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Server frames are JSON by contract; if we can't parse,
      // something is very wrong — surface as an error and let
      // reconnect / dev-tools catch it.
      useConnectionStatus.getState().setError("malformed_frame");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).type !== "string"
    ) {
      useConnectionStatus.getState().setError("malformed_frame");
      return;
    }
    const msg = parsed as ServerMessage;

    switch (msg.type) {
      case "hello":
        this.handleHello(msg as ServerHello);
        return;
      case "pong":
        // Heartbeat round-trip OK — clear the watchdog.
        this.clearPongWatchdog();
        return;
      case "ops:upsert":
      case "ops:delete":
      case "ops:batch": {
        const opMsg = msg as ServerOpsUpsert | ServerOpsDelete | ServerOpsBatch;
        // Phase 4 — dedupe by seq. Replay + live PUBSUB can overlap
        // during the sub-millisecond window between the server's
        // SUBSCRIBE and its read of last_event_seq for hello, so the
        // same envelope can hit the wire twice. Apply once: only call
        // onOps when seq strictly advances the watermark.
        const current = useConnectionStatus.getState().lastEventSeq;
        if (opMsg.seq <= current) {
          return;
        }
        useConnectionStatus.getState().bumpSeq(opMsg.seq);
        this.options.onOps?.(opMsg);
        return;
      }
      case "resync":
        this.options.onResync?.(msg as ServerResync);
        return;
      case "error":
        this.options.onError?.(msg as ServerError);
        return;
      case "presence:join":
      case "presence:leave":
      case "presence:cursor":
      case "presence:focus":
        this.options.onPresence?.(msg as PresenceEnvelope);
        return;
      default:
        this.options.onUnknown?.(msg as ServerUnknown);
        return;
    }
  }

  private handleHello(msg: ServerHello): void {
    if (msg.v !== PROTOCOL_VERSION) {
      // Different envelope version: don't apply, but stay connected
      // so the UI can surface "server protocol mismatch" via the
      // error channel.
      useConnectionStatus.getState().setError("protocol_version_mismatch");
      this.options.onError?.({
        v: PROTOCOL_VERSION,
        type: "error",
        code: "protocol_version_mismatch",
        message: `expected v=${PROTOCOL_VERSION}, got v=${msg.v}`,
      });
      return;
    }
    useConnectionStatus.getState().applyHello({
      sessionId: msg.session_id,
      lastEventSeq: msg.last_event_seq,
    });
    this.startHeartbeat();
    this.options.onHello?.(msg);
  }

  private handleClose(code: number, reason: string): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.stopped) {
      // Intentional close — leave status alone (stop() already set it).
      return;
    }
    // Auth failure (custom 4401 close code from the server) is
    // terminal — a fresh ticket won't help if the ticket couldn't be
    // validated at all. Surface and stop reconnecting.
    if (code === 4401) {
      useConnectionStatus.setState({
        status: "disconnected",
        currentSessionId: null,
        lastError: reason || "unauthorized",
      });
      return;
    }
    useConnectionStatus.setState({
      currentSessionId: null,
      lastError: reason || `close_${code}`,
    });
    this.scheduleReconnect();
  }

  private handleFatalConnectError(_error: unknown, code: string): void {
    if (this.stopped) {
      return;
    }
    useConnectionStatus.getState().setError(code);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const state = useConnectionStatus.getState();
    state.incrementReconnectAttempt();
    state.setStatus("reconnecting");
    const delay = computeBackoffMs(state.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---- heartbeat ----------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "ping" }));
      } catch {
        /* socket dying; close handler will pick up */
        return;
      }
      this.armPongWatchdog();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongWatchdog();
  }

  private armPongWatchdog(): void {
    this.clearPongWatchdog();
    this.pongWatchdog = setTimeout(() => {
      // No pong within the window — assume the socket is wedged and
      // force a close. The close handler will schedule reconnect.
      if (this.ws) {
        try {
          this.ws.close(4000, "pong_timeout");
        } catch {
          /* ignore */
        }
      }
    }, PONG_TIMEOUT_MS);
  }

  private clearPongWatchdog(): void {
    if (this.pongWatchdog) {
      clearTimeout(this.pongWatchdog);
      this.pongWatchdog = null;
    }
  }
}

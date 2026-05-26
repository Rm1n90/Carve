// Armin Mehri — mehri.armin@gmail.com
/**
 * Transport-layer tests for the realtime WebSocket client.
 *
 * No network: a ``MockWebSocket`` class is injected via
 * ``RealtimeClient.options.webSocketImpl`` so each test can drive the
 * connection lifecycle synchronously (``simulateMessage`` /
 * ``simulateClose``). The ticket fetcher is also injected so we don't
 * need the axios client.
 *
 * What we pin here:
 *
 *   * URL building: scheme swap, ``?ticket=…`` always present,
 *     ``?last_event_seq=`` only when > 0.
 *   * Back-off math: monotonically increasing, capped, with jitter.
 *   * Connection-status store transitions across hello / ops / close.
 *   * Dispatch table: each server type ends up on the right callback.
 *   * Reconnect contract: schedules on transient close, terminal on
 *     4401, suppressed after ``stop()``.
 *   * Heartbeat: ping is sent on the cadence; pong clears the
 *     watchdog; missing pong force-closes the socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RealtimeClient,
  buildWebSocketUrl,
  computeBackoffMs,
  toWebSocketBaseUrl,
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
} from "@/realtime/ws";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import { PROTOCOL_VERSION, type ServerMessage } from "@/realtime/types";

// ---------------- MockWebSocket --------------------------------------------

type Listener<E> = ((ev: E) => void) | null;

interface MockEvent {
  data: unknown;
}

interface MockCloseEvent {
  code: number;
  reason: string;
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  static readonly instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  closed = false;

  onopen: Listener<unknown> = null;
  onmessage: Listener<MockEvent> = null;
  onclose: Listener<MockCloseEvent> = null;
  onerror: Listener<unknown> = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Fire onopen on the next microtask so the transport's handlers
    // have a chance to be wired up.
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // Test-only helpers ------------------------------------------------

  simulateMessage(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateRawMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  simulateClose(code = 1006, reason = "abnormal"): void {
    this.close(code, reason);
  }
}

// ---------------- Fixtures --------------------------------------------------

const TASK_ID = "11111111-1111-1111-1111-111111111111";
const TICKET = "fake-ticket-value-padded-to-min-length-32+";
const SESSION_ID = "22222222-2222-2222-2222-222222222222";

function helloMessage(
  opts: Partial<{ session: string; seq: number; v: number }> = {},
) {
  return {
    v: opts.v ?? PROTOCOL_VERSION,
    type: "hello",
    session_id: opts.session ?? SESSION_ID,
    user_id: "33333333-3333-3333-3333-333333333333",
    task_id: TASK_ID,
    server_time: 1_700_000_000_000,
    last_event_seq: opts.seq ?? 0,
    presence: [],
  } as const;
}

function makeClient(
  overrides: Partial<{
    ticketFetcher: (taskId: string) => Promise<string>;
    baseUrl: string;
    onOps: (m: ServerMessage) => void;
    onHello: (m: ServerMessage) => void;
    onResync: (m: ServerMessage) => void;
    onError: (m: ServerMessage) => void;
    onUnknown: (m: ServerMessage) => void;
  }> = {},
): RealtimeClient {
  return new RealtimeClient({
    taskId: TASK_ID,
    baseUrl: overrides.baseUrl ?? "/api",
    ticketFetcher: overrides.ticketFetcher ?? (async () => TICKET),
    webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    onOps: overrides.onOps as never,
    onHello: overrides.onHello as never,
    onResync: overrides.onResync as never,
    onError: overrides.onError as never,
    onUnknown: overrides.onUnknown as never,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  useConnectionStatus.getState().reset();
  MockWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  MockWebSocket.instances.length = 0;
});

// ---------------- Pure helpers ----------------------------------------------

describe("buildWebSocketUrl", () => {
  it("uses ws scheme for http base", () => {
    const url = buildWebSocketUrl({
      base: "http://localhost:8000/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 0,
    });
    expect(url.startsWith("ws://localhost:8000/api/realtime/ws/")).toBe(true);
  });

  it("uses wss scheme for https base", () => {
    const url = buildWebSocketUrl({
      base: "https://carve.example.com/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 0,
    });
    expect(url.startsWith("wss://carve.example.com/api/realtime/ws/")).toBe(
      true,
    );
  });

  it("derives scheme + host from window.location for a relative base", () => {
    const url = buildWebSocketUrl({
      base: "/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 0,
    });
    // jsdom default URL is http(s)://localhost[:port]; assert the
    // scheme swap and path shape without pinning the port.
    expect(url).toMatch(/^ws:\/\/localhost(?::\d+)?\/api\/realtime\/ws\//);
  });

  it("includes last_event_seq query param only when > 0", () => {
    const cold = buildWebSocketUrl({
      base: "/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 0,
    });
    expect(cold).not.toContain("last_event_seq");
    const warm = buildWebSocketUrl({
      base: "/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 42,
    });
    expect(warm).toContain("last_event_seq=42");
  });

  it("always carries the ticket query param", () => {
    const url = buildWebSocketUrl({
      base: "/api",
      taskId: TASK_ID,
      ticket: TICKET,
      lastEventSeq: 0,
    });
    expect(url).toContain(`ticket=${encodeURIComponent(TICKET)}`);
  });
});

describe("toWebSocketBaseUrl", () => {
  it("normalises trailing slashes", () => {
    expect(toWebSocketBaseUrl("http://x/api/")).toBe("ws://x/api");
  });
});

describe("computeBackoffMs", () => {
  it("grows monotonically (modulo jitter) across attempts", () => {
    // Pin Math.random so the test isn't flaky from jitter.
    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const a0 = computeBackoffMs(0);
      const a3 = computeBackoffMs(3);
      const a10 = computeBackoffMs(10);
      expect(a0).toBeGreaterThanOrEqual(RECONNECT_MIN_DELAY_MS * 0.75);
      expect(a3).toBeGreaterThan(a0);
      expect(a10).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    } finally {
      mockRandom.mockRestore();
    }
  });

  it("caps at the configured max", () => {
    const mockRandom = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      // 2^100 * 500ms is astronomical — must be clamped.
      expect(computeBackoffMs(100)).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    } finally {
      mockRandom.mockRestore();
    }
  });
});

// ---------------- Connection lifecycle --------------------------------------

describe("RealtimeClient — connect + hello", () => {
  it("fetches a ticket and constructs a WS with the resolved URL", async () => {
    const ticketFetcher = vi.fn(async (id: string) => {
      expect(id).toBe(TASK_ID);
      return TICKET;
    });
    const client = makeClient({ ticketFetcher });
    await client.start();
    await flushMicrotasks();

    expect(ticketFetcher).toHaveBeenCalledOnce();
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toContain(`/realtime/ws/${TASK_ID}`);
    expect(ws.url).toContain(`ticket=${encodeURIComponent(TICKET)}`);
    expect(useConnectionStatus.getState().status).toBe("connecting");
    client.stop();
  });

  it("transitions to connected only after hello arrives (not on open)", async () => {
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    // open has fired by now; status should still be ``connecting`` since
    // no hello has been simulated.
    expect(useConnectionStatus.getState().status).toBe("connecting");
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    expect(useConnectionStatus.getState().status).toBe("connected");
    expect(useConnectionStatus.getState().currentSessionId).toBe(SESSION_ID);
    client.stop();
  });

  it("on hello with a smaller last_event_seq, does NOT rewind the watermark", async () => {
    useConnectionStatus.setState({ lastEventSeq: 99 });
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage({ seq: 5 }));
    expect(useConnectionStatus.getState().lastEventSeq).toBe(99);
    client.stop();
  });

  it("on hello with a larger last_event_seq, advances the watermark", async () => {
    useConnectionStatus.setState({ lastEventSeq: 5 });
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage({ seq: 42 }));
    expect(useConnectionStatus.getState().lastEventSeq).toBe(42);
    client.stop();
  });

  it("on hello with a mismatched envelope version, surfaces an error", async () => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage({ v: 2 }));
    expect(useConnectionStatus.getState().lastError).toBe(
      "protocol_version_mismatch",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "protocol_version_mismatch" }),
    );
    client.stop();
  });
});

// ---------------- Dispatch --------------------------------------------------

describe("RealtimeClient — dispatch", () => {
  it("routes ops:* envelopes to onOps and bumps lastEventSeq", async () => {
    const onOps = vi.fn();
    const client = makeClient({ onOps });
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());

    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "ops:upsert",
      seq: 1,
      ts: 1,
      annotation: { id: "a" },
      actor_id: "u",
      origin_session: null,
    } as ServerMessage);
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "ops:delete",
      seq: 2,
      ts: 2,
      annotation_id: "a",
      actor_id: "u",
      origin_session: null,
    } as ServerMessage);
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "ops:batch",
      seq: 3,
      ts: 3,
      ops: [],
      actor_id: "u",
      origin_session: null,
    } as ServerMessage);

    expect(onOps).toHaveBeenCalledTimes(3);
    expect(useConnectionStatus.getState().lastEventSeq).toBe(3);
    client.stop();
  });

  it("routes resync to onResync without closing the connection", async () => {
    const onResync = vi.fn();
    const client = makeClient({ onResync });
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "resync",
      reason: "gap_replay",
    } as ServerMessage);
    expect(onResync).toHaveBeenCalledOnce();
    expect(ws.closed).toBe(false);
    expect(useConnectionStatus.getState().status).toBe("connected");
    client.stop();
  });

  it("routes error to onError without closing the connection", async () => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "error",
      code: "unknown_type",
      message: "noop",
    } as ServerMessage);
    expect(onError).toHaveBeenCalledOnce();
    expect(ws.closed).toBe(false);
    client.stop();
  });

  it("routes unknown types to onUnknown for forward-compat", async () => {
    const onUnknown = vi.fn();
    const client = makeClient({ onUnknown });
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "future:type",
      payload: { future: true },
    } as unknown as ServerMessage);
    expect(onUnknown).toHaveBeenCalledOnce();
    client.stop();
  });

  it("marks malformed frames as an error without crashing", async () => {
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    ws.simulateRawMessage("not json");
    expect(useConnectionStatus.getState().lastError).toBe("malformed_frame");
    expect(ws.closed).toBe(false);
    client.stop();
  });
});

// ---------------- Reconnect + stop ------------------------------------------

describe("RealtimeClient — reconnect", () => {
  it("schedules a reconnect on a transient close (code 1006)", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateMessage(helloMessage());

    ws1.simulateClose(1006, "abnormal");
    expect(useConnectionStatus.getState().status).toBe("reconnecting");
    expect(useConnectionStatus.getState().reconnectAttempt).toBe(1);
    expect(useConnectionStatus.getState().currentSessionId).toBe(null);

    // Advance time past the back-off window. We don't know the exact
    // jitter, but a 60 s tick covers any single attempt up to the cap.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(2);
    client.stop();
  });

  it("a 4401 close is terminal — no reconnect is scheduled", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());

    ws.simulateClose(4401, "invalid_ticket");
    expect(useConnectionStatus.getState().status).toBe("disconnected");
    expect(useConnectionStatus.getState().lastError).toBe("invalid_ticket");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    client.stop();
  });

  it("stop() cancels pending reconnect and never opens another socket", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());
    ws.simulateClose(1006, "abnormal");
    expect(useConnectionStatus.getState().status).toBe("reconnecting");

    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(useConnectionStatus.getState().status).toBe("disconnected");
    expect(useConnectionStatus.getState().currentSessionId).toBe(null);
  });

  it("ticket fetch failure schedules a reconnect (transient backend error)", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const ticketFetcher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("boom");
      }
      return TICKET;
    });
    const client = makeClient({ ticketFetcher });
    await client.start();
    await flushMicrotasks();
    expect(useConnectionStatus.getState().lastError).toBe("ticket_fetch_failed");
    expect(useConnectionStatus.getState().status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(ticketFetcher).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(1);
    client.stop();
  });
});

// ---------------- Heartbeat -------------------------------------------------

describe("RealtimeClient — heartbeat", () => {
  it("sends a ping after the heartbeat interval and clears the watchdog on pong", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());

    expect(ws.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1);
    expect(ws.sent).toHaveLength(1);
    const ping = JSON.parse(ws.sent[0]!) as { type: string; v: number };
    expect(ping.type).toBe("ping");
    expect(ping.v).toBe(PROTOCOL_VERSION);

    // Pong before the watchdog fires — connection stays alive.
    ws.simulateMessage({
      v: PROTOCOL_VERSION,
      type: "pong",
      server_time: 0,
    } as ServerMessage);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS + 1_000);
    expect(ws.closed).toBe(false);
    client.stop();
  });

  it("force-closes the WS when no pong arrives within the watchdog window", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    await client.start();
    await flushMicrotasks();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateMessage(helloMessage());

    // Trigger a ping, then let the watchdog expire without a pong.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS + 1);
    expect(ws.closed).toBe(true);
    expect(useConnectionStatus.getState().status).toBe("reconnecting");
    client.stop();
  });
});

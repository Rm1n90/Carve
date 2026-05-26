// Armin Mehri — mehri.armin@gmail.com
/**
 * Wire-level types for the realtime collaboration protocol.
 *
 * The shapes here mirror ``apps/api/src/carve_api/realtime/schemas.py``
 * exactly. When the server schema changes, this file must be updated
 * in lockstep — the protocol is versioned at the envelope level
 * (``v: 1``) and bumping the version is a deliberate breaking change.
 *
 * Forward-compatibility: the dispatcher in :mod:`ws` represents
 * unrecognised ``type`` values as ``ServerUnknown`` rather than
 * crashing. That lets an older client safely connect to a newer
 * server that has added new message types.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------- Inbound (client → server) ---------------------------------------

export interface ClientPing {
  v: 1;
  type: "ping";
}

export interface ClientPresenceCursor {
  v: 1;
  type: "presence:cursor";
  asset_id: string; // uuid
  frame_id?: string | null;
  // Image-pixel coordinates, not screen pixels. Floats so we can
  // smoothly interpolate between received cursors at the same zoom.
  x: number;
  y: number;
}

export interface ClientFocusTarget {
  kind: "annotation";
  id: string; // uuid
}

export interface ClientPresenceFocus {
  v: 1;
  type: "presence:focus";
  target?: ClientFocusTarget | null;
}

export type ClientMessage =
  | ClientPing
  | ClientPresenceCursor
  | ClientPresenceFocus;

// ---------- Outbound (server → client) --------------------------------------

export interface PresenceUser {
  user_id: string;
  session_id: string;
  name: string;
  color: string; // ``#rrggbb``
}

export interface ServerHello {
  v: 1;
  type: "hello";
  session_id: string;
  user_id: string;
  task_id: string;
  server_time: number; // epoch ms
  last_event_seq: number;
  presence: PresenceUser[];
}

export interface ServerPong {
  v: 1;
  type: "pong";
  server_time: number;
}

export interface ServerError {
  v: 1;
  type: "error";
  code: string;
  message: string;
}

export interface ServerResync {
  v: 1;
  type: "resync";
  reason: "gap_replay" | "internal";
}

export interface ServerOpsUpsert {
  v: 1;
  type: "ops:upsert";
  seq: number;
  ts: number;
  annotation: Record<string, unknown>; // ``AnnotationOut`` shape from the REST API
  actor_id: string;
  origin_session: string | null;
}

export interface ServerOpsDelete {
  v: 1;
  type: "ops:delete";
  seq: number;
  ts: number;
  annotation_id: string;
  actor_id: string;
  origin_session: string | null;
}

export interface ServerOpsBatchEntry {
  type: "ops:upsert" | "ops:delete";
  annotation?: Record<string, unknown>;
  annotation_id?: string;
}

export interface ServerOpsBatch {
  v: 1;
  type: "ops:batch";
  seq: number;
  ts: number;
  ops: ServerOpsBatchEntry[];
  actor_id: string;
  origin_session: string | null;
}

export interface ServerPresenceJoin {
  v: 1;
  type: "presence:join";
  user: PresenceUser;
}

export interface ServerPresenceLeave {
  v: 1;
  type: "presence:leave";
  session_id: string;
  user_id: string;
}

export interface ServerPresenceCursor {
  v: 1;
  type: "presence:cursor";
  session_id: string;
  user_id: string;
  asset_id: string;
  frame_id?: string | null;
  x: number;
  y: number;
}

export interface ServerPresenceFocus {
  v: 1;
  type: "presence:focus";
  session_id: string;
  user_id: string;
  target: ClientFocusTarget | null;
}

/** Fallback envelope for forward-compatibility — wraps any ``type``
 *  this client doesn't yet recognise. Carries the raw payload so a
 *  future consumer (or telemetry) can still inspect it. */
export interface ServerUnknown {
  v: number;
  type: string;
  [k: string]: unknown;
}

export type ServerMessage =
  | ServerHello
  | ServerPong
  | ServerError
  | ServerResync
  | ServerOpsUpsert
  | ServerOpsDelete
  | ServerOpsBatch
  | ServerPresenceJoin
  | ServerPresenceLeave
  | ServerPresenceCursor
  | ServerPresenceFocus
  | ServerUnknown;

// ---------- Error codes ------------------------------------------------------

/** Stable string constants the UI may pattern-match on. */
export const ErrorCode = {
  INVALID_TICKET: "invalid_ticket",
  TICKET_TASK_MISMATCH: "ticket_task_mismatch",
  UNKNOWN_TYPE: "unknown_type",
  INVALID_PAYLOAD: "invalid_payload",
  BACKPRESSURE_OVERFLOW: "backpressure_overflow",
  INTERNAL: "internal",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------- Type guards ------------------------------------------------------

/** True when ``msg`` is one of the data-sync envelopes (Phase 2). */
export function isOpsMessage(
  msg: ServerMessage,
): msg is ServerOpsUpsert | ServerOpsDelete | ServerOpsBatch {
  return (
    msg.type === "ops:upsert" ||
    msg.type === "ops:delete" ||
    msg.type === "ops:batch"
  );
}

/** True when ``msg`` is one of the presence envelopes (Phase 5/6). */
export function isPresenceMessage(msg: ServerMessage): boolean {
  return (
    msg.type === "presence:join" ||
    msg.type === "presence:leave" ||
    msg.type === "presence:cursor" ||
    msg.type === "presence:focus"
  );
}

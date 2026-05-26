// Armin Mehri — mehri.armin@gmail.com
/**
 * Zustand store + helpers for tracking other users connected to the
 * same task.
 *
 * Layered intentionally above the transport: ``ws.ts`` parses inbound
 * presence:* envelopes and ``applyPresence.ts`` calls these store
 * actions. UI components (``PresenceChips``, ``PresenceCursorLayer``)
 * subscribe directly.
 *
 * Color rule (mirrors :func:`carve_api.realtime.presence.color_for_user`
 * on the backend exactly): SHA-256 of the UUID's 16 raw bytes; first
 * byte modulo palette length picks the entry. Same palette + same hash
 * means both sides of the wire render a given collaborator in the
 * same color.
 */

import { create } from "zustand";

// -------- Palette ------------------------------------------------------------

/** 10-color palette. Order is meaningful — re-ordering would shift every
 *  user's assigned color. Mirrors ``PRESENCE_PALETTE`` on the server. */
export const PRESENCE_PALETTE = [
  "#f87171", // red-400
  "#fb923c", // orange-400
  "#fbbf24", // amber-400
  "#a3e635", // lime-400
  "#34d399", // emerald-400
  "#22d3ee", // cyan-400
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#f472b6", // pink-400
  "#94a3b8", // slate-400
] as const;

/** UUID string (8-4-4-4-12 hex) → 16-byte Uint8Array. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    // Defensive: if the server ever sends an odd id, fall back to a
    // stable zero buffer rather than crashing the whole store.
    return new Uint8Array(16);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256First(bytes: Uint8Array): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest)[0]!;
}

const colorCache = new Map<string, string>();

/**
 * Deterministic palette pick for ``user_id``. Synchronous after the
 * first call per user (memoized). On the first miss we return a cheap
 * synchronous fallback (sum-of-bytes mod palette) while we kick off
 * the SHA-256 digest in the background; once the digest resolves we
 * overwrite the cached value. The colour may therefore flip once
 * shortly after a new user joins — a sub-second flicker, after which
 * the result matches the server exactly.
 *
 * The synchronous-first design exists because Zustand actions cannot
 * be async and we don't want every render to await crypto.
 */
export function colorForUser(userId: string): string {
  const cached = colorCache.get(userId);
  if (cached) return cached;
  const bytes = uuidToBytes(userId);
  // Cheap synchronous seed — sum of all bytes modulo palette length.
  // Doesn't match the SHA-256 result but is stable per user_id and
  // returns immediately so the first paint isn't blank.
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum = (sum + bytes[i]!) & 0xff;
  const seed = PRESENCE_PALETTE[sum % PRESENCE_PALETTE.length]!;
  colorCache.set(userId, seed);
  // Compute the canonical color in the background. Falls back to the
  // seed if SubtleCrypto is unavailable (server's color may then
  // disagree, acceptable for that degraded environment).
  void (async () => {
    try {
      const idx = await sha256First(bytes);
      const real = PRESENCE_PALETTE[idx % PRESENCE_PALETTE.length]!;
      colorCache.set(userId, real);
    } catch {
      /* keep seed */
    }
  })();
  return seed;
}

/** Reset the color cache. Tests only. */
export function _resetColorCacheForTest(): void {
  colorCache.clear();
}

// -------- Store --------------------------------------------------------------

export interface PresenceCursor {
  asset_id: string;
  frame_id: string | null;
  x: number; // image-pixel coords
  y: number;
  /** epoch ms — used by the UI to fade stale cursors. */
  updated_at: number;
}

export interface PresenceFocusTarget {
  kind: "annotation";
  id: string;
}

export interface PresenceUser {
  user_id: string;
  session_id: string;
  name: string;
  color: string;
  cursor: PresenceCursor | null;
  focus: PresenceFocusTarget | null;
}

interface PresenceState {
  /** Keyed by session_id — a user with two tabs appears as two
   *  entries with the same user_id / name / color but different
   *  session ids. Phase 6 surfaces them separately; coalescing is a
   *  future polish. */
  bySession: Record<string, PresenceUser>;

  // Actions ------------------------------------------------------------

  /** Seed the store from ``hello.presence``. Replaces the entire map
   *  — a fresh hello means we're (re)joining a task and any prior
   *  state from a previous task is stale. */
  applyHelloPresence(snapshot: PresenceUser[]): void;
  applyJoin(user: PresenceUser): void;
  applyLeave(sessionId: string): void;
  applyCursor(args: {
    session_id: string;
    user_id: string;
    asset_id: string;
    frame_id: string | null;
    x: number;
    y: number;
  }): void;
  applyFocus(args: {
    session_id: string;
    user_id: string;
    target: PresenceFocusTarget | null;
  }): void;
  /** Drop every entry. Called when the WS task changes or unmounts. */
  reset(): void;
}

export const usePresence = create<PresenceState>((set) => ({
  bySession: {},

  applyHelloPresence: (snapshot) =>
    set(() => ({
      bySession: Object.fromEntries(
        snapshot.map((u) => [
          u.session_id,
          { ...u, cursor: u.cursor ?? null, focus: u.focus ?? null },
        ]),
      ),
    })),

  applyJoin: (user) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [user.session_id]: {
          ...user,
          cursor: user.cursor ?? null,
          focus: user.focus ?? null,
        },
      },
    })),

  applyLeave: (sessionId) =>
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.bySession;
      void _drop;
      return { bySession: rest };
    }),

  applyCursor: ({ session_id, asset_id, frame_id, x, y }) =>
    set((s) => {
      const existing = s.bySession[session_id];
      if (!existing) {
        // Cursor arrived for a session we don't know about. Could
        // happen if the join was dropped or if we missed a hello.
        // Ignore — when the join eventually arrives, the next
        // cursor will populate state.
        return s;
      }
      return {
        bySession: {
          ...s.bySession,
          [session_id]: {
            ...existing,
            cursor: {
              asset_id,
              frame_id,
              x,
              y,
              updated_at: Date.now(),
            },
          },
        },
      };
    }),

  applyFocus: ({ session_id, target }) =>
    set((s) => {
      const existing = s.bySession[session_id];
      if (!existing) return s;
      return {
        bySession: {
          ...s.bySession,
          [session_id]: { ...existing, focus: target },
        },
      };
    }),

  reset: () => set({ bySession: {} }),
}));

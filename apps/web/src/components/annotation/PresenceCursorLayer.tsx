// Armin Mehri — mehri.armin@gmail.com
/**
 * Overlay layer that paints OTHER users' cursors on top of the
 * AnnotationCanvas, positioned via the same transform Pixi uses for
 * the image and shape layers.
 *
 * Implementation notes:
 *
 *   * Rendered as a sibling of the canvas inside a shared wrapper.
 *     The wrapper handles ``position: relative`` so this overlay can
 *     ``position: absolute; inset: 0; pointer-events: none``.
 *   * Cursors live in image-space; we multiply by ``transform.scale``
 *     and add ``transform.offset`` to project to wrapper-local
 *     screen coordinates. Same math the canvas does internally.
 *   * Stale cursors (no movement for ``STALE_AFTER_MS``) fade to half
 *     opacity. Beyond ``REMOVE_AFTER_MS`` they're hidden entirely
 *     (the store still has the entry — leaving is a separate signal).
 *   * Cursors for a different ``asset_id`` than the one the local user
 *     is viewing are NOT rendered (one team-mate looking at asset A
 *     shouldn't see a ghost cursor when viewing asset B).
 */

import { useEffect, useState } from "react";

import { usePresence } from "@/realtime/presence";
import { useConnectionStatus } from "@/realtime/connectionStatus";
import { useEditorSettings } from "@/state/editorSettings";

const STALE_AFTER_MS = 5_000;
const REMOVE_AFTER_MS = 30_000;
const REFRESH_TICK_MS = 1_000;

export interface CanvasTransform {
  scale: number;
  offset: { x: number; y: number };
}

interface Props {
  /** Current canvas transform — pulled out of AnnotationCanvas via
   *  the ``onTransformChange`` callback the page wires up. */
  transform: CanvasTransform;
  /** Asset the local user is currently viewing. Cursors with a
   *  different ``asset_id`` are hidden — a teammate on another asset
   *  shouldn't show as a stray cursor on this one. */
  assetId: string | null;
}

export function PresenceCursorLayer({ transform, assetId }: Props) {
  const bySession = usePresence((s) => s.bySession);
  const selfSession = useConnectionStatus((s) => s.currentSessionId);
  // Phase 7 — user-facing toggle in the Appearance panel. When set,
  // the layer renders nothing. Outbound presence still flows so the
  // local user remains visible to teammates; only this client's
  // inbound cursor display is suppressed.
  const hideCollaborators = useEditorSettings((s) => s.hideCollaborators);

  // Force a periodic re-render so the stale / removed time thresholds
  // are honoured even when no new cursor events arrive. Skip the
  // ticker entirely when the layer is hidden — nothing to refresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (hideCollaborators) return;
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_TICK_MS);
    return () => clearInterval(id);
  }, [hideCollaborators]);

  if (hideCollaborators) return null;

  const now = Date.now();

  return (
    <div
      data-testid="presence-cursor-layer"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {Object.values(bySession).map((user) => {
        if (user.session_id === selfSession) return null;
        const c = user.cursor;
        if (!c) return null;
        // Same-asset filter: don't paint ghost cursors for users on
        // a different asset.
        if (assetId !== null && c.asset_id !== assetId) return null;
        const age = now - c.updated_at;
        if (age > REMOVE_AFTER_MS) return null;
        const stale = age > STALE_AFTER_MS;
        const screenX = c.x * transform.scale + transform.offset.x;
        const screenY = c.y * transform.scale + transform.offset.y;
        return (
          <div
            key={user.session_id}
            data-testid={`presence-cursor-${user.session_id}`}
            className="absolute will-change-transform"
            style={{
              transform: `translate3d(${screenX}px, ${screenY}px, 0)`,
              opacity: stale ? 0.5 : 1,
              transition: "opacity 250ms ease-out",
            }}
          >
            {/* Arrow-style cursor sprite. Drawn in SVG so it scales
                crisply and accepts the user's color via fill. The
                origin (0,0) is the cursor's tip. */}
            <svg
              width="18"
              height="22"
              viewBox="0 0 18 22"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.25))" }}
            >
              <path
                d="M1 1 L1 17 L5.5 13 L8.5 19.5 L11 18.5 L8 12 L13.5 12 Z"
                fill={user.color}
                stroke="#ffffff"
                strokeWidth="1.25"
                strokeLinejoin="round"
              />
            </svg>
            {/* Name tag next to the cursor — only when not stale, to
                keep the canvas legible during idle moments. */}
            {!stale && (
              <span
                className="absolute left-4 top-3 whitespace-nowrap rounded-[var(--radius-xs)] px-1 py-0.5 text-[10px] font-medium text-white shadow-sm"
                style={{ background: user.color }}
              >
                {user.name}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

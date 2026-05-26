// Armin Mehri — mehri.armin@gmail.com
/**
 * Overlay that paints a colored ring around every annotation another
 * user has currently focused, with their name label tucked above the
 * ring. The "X is editing this" signal from Phase 5 / 6 — surfaced
 * visually in Phase 7.
 *
 * Architecture mirrors :class:`PresenceCursorLayer`:
 *
 *   * Sibling of the canvas inside a relatively-positioned wrapper.
 *   * ``position: absolute; inset: 0; pointer-events: none``.
 *   * Reads ``usePresence.bySession`` for users with active focus
 *     plus ``useAnnotations.byId`` for the annotation geometry, then
 *     projects each shape's bounding box into wrapper-local pixel
 *     coordinates via the canvas transform.
 *   * NO modification of the canvas's Pixi paint pass — keeping this
 *     out of AnnotationCanvas avoids the risk of a regression in the
 *     core editor render loop.
 */

import { useMemo } from "react";

import { useConnectionStatus } from "@/realtime/connectionStatus";
import { usePresence } from "@/realtime/presence";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";
import type { CanvasTransform } from "@/components/annotation/PresenceCursorLayer";

/** Padding (image-space pixels) added around the bounding box. */
const HALO_PADDING = 4;

/** Compute the axis-aligned bounding box of a draft in image space.
 *  Returns ``null`` for kinds we don't paint halos around (tag — has
 *  no spatial geometry) or malformed payloads (defensive). */
function bboxOf(draft: AnnotationDraft | undefined): {
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  if (!draft) return null;
  const g = draft.geometry;
  if (g.kind === "bbox") {
    return { x: g.x, y: g.y, w: g.w, h: g.h };
  }
  if (g.kind === "polygon") {
    if (!g.points || g.points.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of g.points) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  // ``mask_rle`` carries a ``size: [w, h]`` we could project, but
  // masks rarely have a tight bounding box without decoding the RLE
  // payload. Skip for v1 — focus halos on bbox + polygon cover the
  // primary case (drawing tools).
  return null;
}

interface Props {
  /** Canvas transform fed in from AnnotationCanvas's onTransformChange. */
  transform: CanvasTransform;
}

interface FocusEntry {
  session_id: string;
  name: string;
  color: string;
  box: { x: number; y: number; w: number; h: number };
}

export function PresenceFocusLayer({ transform }: Props) {
  const bySession = usePresence((s) => s.bySession);
  const byId = useAnnotations((s) => s.byId);
  const selfSession = useConnectionStatus((s) => s.currentSessionId);

  const entries = useMemo<FocusEntry[]>(() => {
    const out: FocusEntry[] = [];
    for (const user of Object.values(bySession)) {
      if (user.session_id === selfSession) continue;
      if (!user.focus || user.focus.kind !== "annotation") continue;
      // ``user.focus.id`` is the server id. The local store may key
      // by tempId (post markPersisted) so we search both fields.
      let draft: AnnotationDraft | undefined;
      for (const d of Object.values(byId)) {
        if (d.serverId === user.focus.id || d.tempId === user.focus.id) {
          draft = d;
          break;
        }
      }
      const box = bboxOf(draft);
      if (!box) continue;
      out.push({
        session_id: user.session_id,
        name: user.name,
        color: user.color,
        box,
      });
    }
    return out;
  }, [bySession, byId, selfSession]);

  if (entries.length === 0) return null;

  return (
    <div
      data-testid="presence-focus-layer"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {entries.map((entry) => {
        const x = entry.box.x * transform.scale + transform.offset.x;
        const y = entry.box.y * transform.scale + transform.offset.y;
        const w = entry.box.w * transform.scale;
        const h = entry.box.h * transform.scale;
        return (
          <div
            key={entry.session_id}
            data-testid={`presence-focus-${entry.session_id}`}
            className="absolute"
            style={{
              left: x - HALO_PADDING,
              top: y - HALO_PADDING,
              width: w + HALO_PADDING * 2,
              height: h + HALO_PADDING * 2,
            }}
          >
            <div
              className="absolute inset-0 rounded-[var(--radius-xs)]"
              style={{
                border: `2px dashed ${entry.color}`,
                boxShadow: `0 0 0 1px rgba(0,0,0,0.25)`,
              }}
            />
            <span
              className="absolute -top-5 left-0 whitespace-nowrap rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
              style={{ background: entry.color }}
            >
              {entry.name} is editing
            </span>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Plus, X } from "lucide-react";

import { TrackPropagateTool } from "@/canvas/tools/TrackPropagateTool";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import {
  useSamTrackBridge,
  type SamTrackMarker,
} from "@/state/samTrackBridge";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * v3.5 Phase E — side-rail panel for SAM video tracking.
 *
 * Wires the existing {@link TrackPropagateTool} into the annotation editor
 * so users can:
 *   1. Open a tracking session on the active video asset.
 *   2. Mark one or more objects on the current frame (a positive point
 *      placed at the centre of the visible canvas — the user iterates
 *      by clicking "Add object" while the active class changes).
 *   3. Propagate forward N frames via the model service.
 *   4. Commit the resulting per-frame, per-object masks as
 *      {@link AnnotationDraft} rows in the in-memory store.
 *   5. Discard / release the session.
 *
 * MVP commit semantics: this panel only knows the ``frameId`` of the
 * currently visible frame because the API does not yet expose a
 * "list frames" endpoint for video assets. So commit only writes
 * annotations for steps whose ``frame_idx`` matches the current frame
 * (i.e. ``startFrameIdx``). That's enough to surface tracking and
 * unblock the audit gap; richer per-frame commit will need the
 * frames-list endpoint that's slated for the mapping-schema rework.
 */
interface SamTrackPanelProps {
  /** UUID of the open video asset. */
  assetId: string;
  /** Frame.id of the currently visible frame, or null if unknown. */
  frameId: string | null;
  /** Frame index (0-based) the user is currently on. */
  currentFrameIdx: number;
  /** Total number of frames in the video. */
  totalFrames: number;
  /**
   * Map of frame_idx → frame_id for any frames whose ids are known to
   * the page. The MVP only knows the current frame; future work fills
   * in neighbouring ids once a frames-list endpoint exists.
   */
  frameIdxToFrameId?: Record<number, string>;
}

interface UiObject {
  objId: number;
  classId: string;
  className: string;
}

export function SamTrackPanel({
  assetId,
  frameId,
  currentFrameIdx,
  totalFrames,
  frameIdxToFrameId,
}: SamTrackPanelProps) {
  const activeClassId = useTool((s) => s.activeClassId);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [stepFrames, setStepFrames] = useState(5);
  const [objects, setObjects] = useState<UiObject[]>([]);
  const [stepsCollected, setStepsCollected] = useState(0);
  const [framesPropagated, setFramesPropagated] = useState(0);

  const toolRef = useRef<TrackPropagateTool | null>(null);
  const [markers, setMarkersLocal] = useState<SamTrackMarker[]>([]);
  const setBridgeMarkers = useSamTrackBridge((s) => s.setMarkers);
  const setBridgeHandler = useSamTrackBridge((s) => s.setHandler);
  const clearBridge = useSamTrackBridge((s) => s.clear);
  // Refs let the canvas-click handler — registered once on mount —
  // read live values without needing to re-register on every state
  // change (which would defeat the pub/sub).
  const sessionOpenRef = useRef(sessionOpen);
  const startingRef = useRef(starting);
  const currentFrameIdxRef = useRef(currentFrameIdx);
  useEffect(() => {
    sessionOpenRef.current = sessionOpen;
  }, [sessionOpen]);
  useEffect(() => {
    startingRef.current = starting;
  }, [starting]);
  useEffect(() => {
    currentFrameIdxRef.current = currentFrameIdx;
  }, [currentFrameIdx]);

  // Re-build the tool whenever the asset changes; the tool internally
  // releases server-side state via release() but we also drop our
  // local handle so a stale session can never leak across assets.
  useEffect(() => {
    toolRef.current = new TrackPropagateTool(assetId, () => activeClassId);
    return () => {
      const t = toolRef.current;
      toolRef.current = null;
      if (t && t.isActive()) {
        // Best-effort release; ignore errors (server may already be gone).
        void t.release();
      }
      setSessionOpen(false);
      setObjects([]);
      setMarkersLocal([]);
      setStepsCollected(0);
      setFramesPropagated(0);
    };
    // ``activeClassId`` is read at click-time via the closure, so we don't
    // include it in the deps — re-creating the tool every class change
    // would orphan the in-flight session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  // Mirror local markers into the bridge slice so <AnnotationCanvas>
  // can paint numbered teach-back markers at each prompted point.
  useEffect(() => {
    setBridgeMarkers(markers);
  }, [markers, setBridgeMarkers]);

  // Register the canvas-click handler once per mount. The handler reads
  // live ``sessionOpen`` / ``starting`` state via refs so we don't need
  // to re-register on every render — re-registration would race with
  // canvas-click events that fire mid-state-update.
  useEffect(() => {
    const handler = (point: [number, number]) => {
      // If a start is mid-flight, drop the click — the user can re-click
      // once the session is open. Re-entrancy here would create two
      // server-side sessions.
      if (startingRef.current) return;
      // Auto-start: a click in track mode is the friendliest UX —
      // it opens the session AND adds the first object.
      const proceed = sessionOpenRef.current
        ? Promise.resolve(true)
        : handleStartSession();
      void proceed.then((ok) => {
        if (!ok) return;
        void addObjectWithPoint(point);
      });
    };
    setBridgeHandler(handler);
    return () => {
      clearBridge();
    };
    // The handler closes over component scope but reads live values via
    // refs; re-registering on every state change is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const classNameForActive = useMemo(() => {
    return activeClassId ?? "(no class selected)";
  }, [activeClassId]);

  async function handleStartSession(): Promise<boolean> {
    const tool = toolRef.current;
    if (!tool) return false;
    setStarting(true);
    try {
      await tool.startEmpty({ frameIdx: currentFrameIdx });
      setSessionOpen(true);
      setObjects([]);
      setMarkersLocal([]);
      setStepsCollected(0);
      setFramesPropagated(0);
      return true;
    } catch {
      showToast("Failed to start tracking session.", { variant: "error" });
      return false;
    } finally {
      setStarting(false);
    }
  }

  async function addObjectWithPoint(
    point: [number, number],
  ): Promise<void> {
    const tool = toolRef.current;
    if (!tool) return;
    if (!activeClassId) {
      showToast("Pick a class first.", { variant: "warning" });
      return;
    }
    try {
      const objId = await tool.addObjectAtFrame(
        currentFrameIdx,
        [point],
        [1],
        activeClassId,
      );
      setObjects((prev) => [
        ...prev,
        { objId, classId: activeClassId, className: activeClassId },
      ]);
      setMarkersLocal((prev) => [
        ...prev,
        { objId, x: point[0], y: point[1] },
      ]);
    } catch {
      showToast("Failed to add tracked object.", { variant: "error" });
    }
  }

  async function handleAddObject() {
    // Button click without a canvas point — keep the legacy MVP behaviour
    // of seeding at (0, 0) so the wiring works without a class+canvas
    // click. The canvas teach-back flow is preferred and goes through
    // ``addObjectWithPoint`` directly.
    await addObjectWithPoint([0, 0]);
  }

  async function handlePropagate() {
    const tool = toolRef.current;
    if (!tool) return;
    if (objects.length === 0) {
      showToast("Add at least one object first.", { variant: "warning" });
      return;
    }
    setStepping(true);
    try {
      const steps = await tool.step(stepFrames);
      setStepsCollected((n) => n + steps.length);
      setFramesPropagated((n) => n + stepFrames);
    } catch {
      showToast("Propagation failed.", { variant: "error" });
    } finally {
      setStepping(false);
    }
  }

  function buildFrameMap(): Record<number, string> {
    // Start with whatever ids the page already knows (current frame at
    // minimum). The tool drops frames missing from this map, which is
    // the documented MVP boundary.
    const base: Record<number, string> = { ...(frameIdxToFrameId ?? {}) };
    if (frameId !== null && base[currentFrameIdx] === undefined) {
      base[currentFrameIdx] = frameId;
    }
    return base;
  }

  function handleCommit() {
    const tool = toolRef.current;
    if (!tool) return;
    const map = buildFrameMap();
    const created = tool.commit(map);
    if (created === 0) {
      showToast(
        "No annotations committed — only the current frame's id is known.",
        { variant: "warning" },
      );
    } else {
      showToast(`Committed ${created} mask annotations from tracking.`, {
        variant: "success",
      });
    }
    // After commit, end the session: the tool clears its internal
    // collected[] but the server-side session is still open until we
    // release it.
    void handleDiscard();
  }

  async function handleDiscard() {
    const tool = toolRef.current;
    if (!tool) return;
    try {
      await tool.release();
    } catch {
      // Best-effort.
    }
    setSessionOpen(false);
    setObjects([]);
    setMarkersLocal([]);
    setStepsCollected(0);
    setFramesPropagated(0);
  }

  const dirtyCount = useAnnotations((s) => Object.keys(s.byId).length);

  return (
    <aside
      role="complementary"
      aria-label="SAM video tracking"
      data-testid="sam-track-panel"
      className={cn(
        "flex flex-col gap-3 p-3 border-t border-[var(--glass-border)]",
        "glass-surface text-[12.5px]",
      )}
    >
      <header className="flex items-center justify-between">
        <span className="font-medium tracking-tight text-[color:var(--text-primary)]">
          Track mode
        </span>
        <span
          data-testid="sam-track-frame-indicator"
          className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]"
        >
          Frame {currentFrameIdx + 1} / {totalFrames}
        </span>
      </header>

      {!sessionOpen && (
        <div className="grid gap-2">
          <p className="text-[11.5px] text-[color:var(--text-secondary)] leading-snug">
            Start a tracking session on this video. You'll mark objects on the
            current frame, then propagate masks forward.
          </p>
          <button
            type="button"
            onClick={handleStartSession}
            disabled={starting}
            data-testid="sam-track-start"
            className={cn(
              "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-full",
              "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
              "hover:bg-[var(--accent-hover)] transition-colors",
              "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)]",
            )}
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {starting ? "Starting…" : "Start tracking"}
          </button>
        </div>
      )}

      {sessionOpen && (
        <>
          <section className="grid gap-2">
            <p className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
              Step 1 — Mark objects
            </p>
            <button
              type="button"
              onClick={handleAddObject}
              data-testid="sam-track-add-object"
              disabled={!activeClassId}
              className={cn(
                "inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-sm)]",
                "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
                "hover:bg-[var(--bg-hover)] transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              Add object ({classNameForActive})
            </button>
            {objects.length > 0 && (
              <ul
                data-testid="sam-track-object-list"
                className="grid gap-1 mt-1"
              >
                {objects.map((o) => (
                  <li
                    key={o.objId}
                    data-testid={`sam-track-object-${o.objId}`}
                    className="flex items-center gap-1.5 text-[11.5px]"
                  >
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">
                      #{o.objId}
                    </span>
                    <span className="flex-1 truncate text-[color:var(--text-secondary)]">
                      {o.className}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2">
            <p className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
              Step 2 — Propagate
            </p>
            <div className="flex items-center gap-2">
              <label
                htmlFor="sam-track-step-frames"
                className="text-[11.5px] text-[color:var(--text-secondary)]"
              >
                Frames
              </label>
              <input
                id="sam-track-step-frames"
                type="number"
                min={1}
                max={500}
                value={stepFrames}
                onChange={(e) =>
                  setStepFrames(
                    Math.max(1, Math.min(500, Number(e.target.value) || 1)),
                  )
                }
                data-testid="sam-track-step-frames"
                className={cn(
                  "h-7 w-16 px-1.5 rounded-[var(--radius-sm)] font-mono tabular-nums",
                  "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
                  "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                )}
              />
              <button
                type="button"
                onClick={handlePropagate}
                disabled={stepping || objects.length === 0}
                data-testid="sam-track-propagate"
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-sm)]",
                  "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
                  "hover:bg-[var(--accent-hover)] transition-colors",
                  "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
                )}
              >
                {stepping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {stepping ? "Stepping…" : "Propagate"}
              </button>
            </div>
            {stepsCollected > 0 && (
              <p
                data-testid="sam-track-progress"
                className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums"
              >
                Tracked {stepsCollected} frames ({framesPropagated} propagated)
              </p>
            )}
          </section>

          <section className="grid gap-2 border-t border-[var(--glass-border)] pt-2">
            <p className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
              Step 3 — Review &amp; commit
            </p>
            <p className="text-[11px] text-[color:var(--text-tertiary)] leading-snug">
              MVP: only the current frame's mask is committed locally; richer
              per-frame review lands once the frames-list endpoint ships.
              Existing drafts: <span className="tabular-nums">{dirtyCount}</span>.
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleCommit}
                disabled={objects.length === 0 || stepsCollected === 0}
                data-testid="sam-track-commit"
                className={cn(
                  "inline-flex flex-1 items-center justify-center gap-1.5 h-7 px-2.5 rounded-full",
                  "bg-[var(--success)] text-white font-medium",
                  "hover:bg-[var(--success-hover)] transition-colors",
                  "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
                )}
              >
                Commit
              </button>
              <button
                type="button"
                onClick={() => void handleDiscard()}
                data-testid="sam-track-discard"
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-sm)]",
                  "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                  "transition-colors",
                )}
              >
                <X className="h-3.5 w-3.5" />
                Discard
              </button>
            </div>
          </section>
        </>
      )}
    </aside>
  );
}

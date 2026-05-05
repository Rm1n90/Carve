// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MousePointerClick, Play, Square, Trash2, X } from "lucide-react";

import { TrackPropagateTool } from "@/canvas/tools/TrackPropagateTool";
import { useTool } from "@/state/tool";
import {
  useSamTrackBridge,
  type SamTrackMarker,
} from "@/state/samTrackBridge";
import { showToast } from "@/lib/toast";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { describeSamError } from "@/components/annotation/AnnotationCanvas";

/**
 * v3.8 Phase 4-video step F8 — simplified tracker panel.
 *
 *  1. Click on the canvas → seeds a point object.
 *  2. Drag a rectangle  → seeds a bbox object.
 *  3. Repeat for additional objects (switch active class between adds
 *     to track multi-class).
 *  4. Press "Start tracking" — propagates to the end of the video,
 *     auto-commits the per-frame masks, releases the session.
 *
 * No text mode, no concept-vs-tracker dispatch, no Discard/Commit
 * buttons. The session is opened lazily on the first add and released
 * on completion or panel unmount.
 */
interface SamTrackPanelProps {
  assetId: string;
  frameId: string | null;
  currentFrameIdx: number;
  totalFrames: number;
  frameIdxToFrameId?: Record<number, string>;
  classes?: import("@/api/classes").ClassRow[];
}

type SeedKind = "point" | "box" | "text";

interface UiObject {
  objId: number;
  classId: string;
  seed: SeedKind;
}

export function SamTrackPanel({
  assetId,
  frameId,
  currentFrameIdx,
  totalFrames,
  frameIdxToFrameId,
  classes,
}: SamTrackPanelProps) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const [starting, setStarting] = useState(false);
  const [stepping, setStepping] = useState(false);
  const TRACK_BATCH = 8;
  const cancelRef = useRef(false);
  const [objects, setObjects] = useState<UiObject[]>([]);
  const [textValue, setTextValue] = useState("");
  const [framesPropagated, setFramesPropagated] = useState(0);

  const toolRef = useRef<TrackPropagateTool | null>(null);
  const [markers, setMarkersLocal] = useState<SamTrackMarker[]>([]);
  const setBridgeMarkers = useSamTrackBridge((s) => s.setMarkers);
  const setBridgeHandler = useSamTrackBridge((s) => s.setHandler);
  const setBridgeBoxHandler = useSamTrackBridge((s) => s.setBoxHandler);
  const clearBridge = useSamTrackBridge((s) => s.clear);

  const startingRef = useRef(starting);
  const currentFrameIdxRef = useRef(currentFrameIdx);
  useEffect(() => {
    startingRef.current = starting;
  }, [starting]);
  useEffect(() => {
    currentFrameIdxRef.current = currentFrameIdx;
  }, [currentFrameIdx]);

  // Build the tool once per asset; release any leftover server session.
  useEffect(() => {
    toolRef.current = new TrackPropagateTool(assetId, () =>
      useTool.getState().activeClassId,
    );
    return () => {
      const t = toolRef.current;
      toolRef.current = null;
      if (t && t.isActive()) {
        void t.release();
      }
      setObjects([]);
      setMarkersLocal([]);
      setFramesPropagated(0);
    };
  }, [assetId]);

  useEffect(() => {
    setBridgeMarkers(markers);
  }, [markers, setBridgeMarkers]);

  // Resolve which class to attach a new object to. Reads live so a
  // class picked any time before the click counts. Falls back to the
  // first known class if the user hasn't picked one yet — eliminates
  // the "no class selected" dead-end and matches the user's mental
  // model that the panel is the source of truth.
  function resolveClassId(): string | null {
    const live = useTool.getState().activeClassId;
    if (live) return live;
    const first = (classes ?? [])[0]?.id ?? null;
    if (first) {
      setActiveClassId(first);
      return first;
    }
    return null;
  }

  async function ensureSession(): Promise<boolean> {
    const tool = toolRef.current;
    if (!tool) return false;
    if (tool.isActive()) return true;
    setStarting(true);
    try {
      await tool.startEmpty({ frameIdx: currentFrameIdxRef.current });
      return true;
    } catch (err) {
      showToast(`Failed to start tracking: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
      return false;
    } finally {
      setStarting(false);
    }
  }

  async function addObjectWithPoint(point: [number, number]): Promise<void> {
    if (startingRef.current) return;
    const classId = resolveClassId();
    if (!classId) {
      showToast("Create a class first.", { variant: "warning" });
      return;
    }
    const ok = await ensureSession();
    if (!ok) return;
    const tool = toolRef.current;
    if (!tool) return;
    try {
      const objId = await tool.addObjectAtFrame(
        currentFrameIdxRef.current,
        [point],
        [1],
        classId,
      );
      setObjects((prev) => [...prev, { objId, classId, seed: "point" }]);
      setMarkersLocal((prev) => [...prev, { objId, x: point[0], y: point[1] }]);
    } catch (err) {
      showToast(`Failed to add tracked object: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
    }
  }

  async function addObjectWithBox(
    box: [number, number, number, number],
  ): Promise<void> {
    if (startingRef.current) return;
    const classId = resolveClassId();
    if (!classId) {
      showToast("Create a class first.", { variant: "warning" });
      return;
    }
    const ok = await ensureSession();
    if (!ok) return;
    const tool = toolRef.current;
    if (!tool) return;
    try {
      const objId = await tool.addObjectAtFrame(
        currentFrameIdxRef.current,
        [],
        [],
        classId,
        [box],
      );
      const cx = (box[0] + box[2]) / 2;
      const cy = (box[1] + box[3]) / 2;
      setObjects((prev) => [...prev, { objId, classId, seed: "box" }]);
      setMarkersLocal((prev) => [...prev, { objId, x: cx, y: cy }]);
    } catch (err) {
      showToast(`Failed to add tracked object: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
    }
  }

  async function addObjectWithText(text: string): Promise<void> {
    if (startingRef.current) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const classId = resolveClassId();
    if (!classId) {
      showToast("Create a class first.", { variant: "warning" });
      return;
    }
    const ok = await ensureSession();
    if (!ok) return;
    const tool = toolRef.current;
    if (!tool) return;
    try {
      const objIds = await tool.addObjectAtFrameWithText(
        currentFrameIdxRef.current,
        trimmed,
        classId,
      );
      if (objIds.length === 0) {
        showToast(`No matches for "${trimmed}".`, { variant: "warning" });
        return;
      }
      setObjects((prev) => [
        ...prev,
        ...objIds.map((objId) => ({ objId, classId, seed: "text" as SeedKind })),
      ]);
    } catch (err) {
      showToast(`Failed to seed text: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
    }
  }

  async function removeObjectRow(objId: number): Promise<void> {
    const tool = toolRef.current;
    if (!tool) return;
    const snapshot = objects;
    setObjects((prev) => prev.filter((o) => o.objId !== objId));
    setMarkersLocal((prev) => prev.filter((m) => m.objId !== objId));
    try {
      await tool.removeObject(objId);
    } catch (err) {
      // Revert optimistic update.
      setObjects(snapshot);
      const errObj = err as { response?: { status?: number; data?: { error?: string } } };
      const isMultiplexErr =
        errObj?.response?.status === 422 ||
        errObj?.response?.data?.error === "tracker_not_multiplex";
      if (isMultiplexErr) {
        showToast("Remove requires SAM 3.1 multiplex backend.", {
          variant: "warning",
          duration: 6000,
        });
      } else {
        showToast(`Failed to remove object: ${describeSamError(err)}`, {
          variant: "error",
          duration: 6000,
        });
      }
    }
  }

  async function clearAll(): Promise<void> {
    const tool = toolRef.current;
    if (tool && tool.isActive()) {
      try {
        await tool.release();
      } catch {
        /* best-effort */
      }
    }
    setObjects([]);
    setMarkersLocal([]);
    setFramesPropagated(0);
  }

  function buildFrameMap(): Record<number, string> {
    const base: Record<number, string> = { ...(frameIdxToFrameId ?? {}) };
    if (frameId !== null && base[currentFrameIdx] === undefined) {
      base[currentFrameIdx] = frameId;
    }
    return base;
  }

  async function handleStartTracking() {
    const tool = toolRef.current;
    if (!tool || objects.length === 0) {
      showToast("Add at least one object first.", { variant: "warning" });
      return;
    }
    cancelRef.current = false;
    setStepping(true);
    setFramesPropagated(0);
    let stepsTotal = 0;
    try {
      while (true) {
        if (cancelRef.current) break;
        const steps = await tool.step(TRACK_BATCH);
        if (steps.length === 0) break;
        stepsTotal += steps.length;
        setFramesPropagated((n) => n + steps.length);
      }
    } catch (err) {
      showToast(`Tracking failed: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
      setStepping(false);
      cancelRef.current = false;
      return;
    }
    setStepping(false);
    cancelRef.current = false;
    let created = 0;
    try {
      created = tool.commit(buildFrameMap());
    } catch (err) {
      showToast(`Commit failed: ${describeSamError(err)}`, {
        variant: "error",
        duration: 6000,
      });
    }
    try {
      await tool.release();
    } catch {
      /* best-effort */
    }
    if (stepsTotal > 0 && created > 0) {
      showToast(`Tracked ${stepsTotal} frames, committed ${created} masks.`, {
        variant: "success",
      });
    } else if (stepsTotal > 0) {
      showToast(
        `Tracked ${stepsTotal} frames but committed 0 — frame-id map missing.`,
        { variant: "warning" },
      );
    }
    setObjects([]);
    setMarkersLocal([]);
  }

  function handleCancel() {
    cancelRef.current = true;
  }

  // Stable bridge wrappers — refs always read the latest add fns so the
  // canvas (which calls handlers from a one-time-registered slot) never
  // captures a stale closure.
  const addPointRef = useRef(addObjectWithPoint);
  const addBoxRef = useRef(addObjectWithBox);
  addPointRef.current = addObjectWithPoint;
  addBoxRef.current = addObjectWithBox;

  useEffect(() => {
    setBridgeHandler((point) => void addPointRef.current(point));
    setBridgeBoxHandler((box) => void addBoxRef.current(box));
    return () => clearBridge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeClass = useMemo(
    () => (classes ?? []).find((c) => c.id === activeClassId) ?? null,
    [classes, activeClassId],
  );

  const progressPct =
    totalFrames > 0
      ? Math.min(100, Math.round((framesPropagated / totalFrames) * 100))
      : 0;
  const canStart = objects.length > 0 && !stepping && !starting;

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
          Track
        </span>
        <span
          data-testid="sam-track-frame-indicator"
          className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]"
        >
          Frame {currentFrameIdx + 1} / {totalFrames}
        </span>
      </header>

      <div className="flex items-center gap-2">
        <span className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
          Class
        </span>
        {activeClass ? (
          <span
            data-testid="sam-track-active-class"
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--bg-subtle)]"
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: activeClass.color }}
            />
            <span className="text-[11.5px] text-[color:var(--text-primary)] truncate max-w-[140px]">
              {activeClass.name}
            </span>
          </span>
        ) : (
          <span className="text-[11.5px] text-[color:var(--text-tertiary)]">
            (will use first class)
          </span>
        )}
      </div>

      {!stepping && (
        <section className="grid gap-2">
          <p className="text-[11px] leading-snug text-[color:var(--text-secondary)]">
            Add objects on this frame, then press <strong>Start tracking</strong>.
            Switch the active class between adds for multi-class tracking.
          </p>

          <ul className="grid gap-1 text-[11px] text-[color:var(--text-secondary)]">
            <li className="flex items-center gap-1.5">
              <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-tertiary)]" />
              <span>Click on the canvas → point seed</span>
            </li>
            <li className="flex items-center gap-1.5">
              <Square className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-tertiary)]" />
              <span>Drag a rectangle → bbox seed</span>
            </li>
          </ul>

          <div className="flex items-center gap-1.5">
            <div className="flex-1">
              <Input
                type="text"
                data-testid="sam-track-text-input"
                placeholder="Type a concept (e.g. person)…"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addObjectWithText(textValue).then(() => setTextValue(""));
                  }
                }}
              />
            </div>
            <button
              type="button"
              data-testid="sam-track-text-submit"
              onClick={() => void addObjectWithText(textValue).then(() => setTextValue(""))}
              disabled={textValue.trim().length === 0}
              className={cn(
                "h-7 px-2 rounded-[var(--radius-xs)] text-[11px]",
                "bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "text-[color:var(--text-secondary)]",
              )}
            >
              Add
            </button>
          </div>

          {objects.length > 0 && (
            <ul
              data-testid="sam-track-object-list"
              className="grid gap-1 mt-1"
            >
              <li className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)]">
                <span>Selected</span>
                <span
                  data-testid="sam-track-object-count"
                  className="font-mono tabular-nums normal-case tracking-normal"
                >
                  {objects.length}
                </span>
              </li>
              {objects.map((o) => {
                const cls = (classes ?? []).find((c) => c.id === o.classId);
                return (
                  <li
                    key={o.objId}
                    data-testid={`sam-track-object-${o.objId}`}
                    className="flex items-center gap-1.5 text-[11.5px]"
                  >
                    <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] w-5">
                      #{o.objId}
                    </span>
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]"
                      style={{ background: cls?.color ?? "var(--bg-hover)" }}
                    />
                    <span className="flex-1 truncate text-[color:var(--text-primary)]">
                      {cls?.name ?? o.classId}
                    </span>
                    <span className="text-[10px] text-[color:var(--text-tertiary)] uppercase tracking-[0.08em] shrink-0">
                      {o.seed}
                    </span>
                    <button
                      type="button"
                      data-testid={`sam-track-remove-${o.objId}`}
                      aria-label={`Remove object #${o.objId}`}
                      onClick={() => void removeObjectRow(o.objId)}
                      className={cn(
                        "ml-1 inline-flex items-center justify-center h-5 w-5 rounded",
                        "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)]",
                        "hover:text-[color:var(--text-primary)] transition-colors shrink-0",
                      )}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  onClick={() => void clearAll()}
                  data-testid="sam-track-clear-all"
                  className={cn(
                    "inline-flex items-center gap-1 h-6 px-2 rounded-[var(--radius-xs)]",
                    "text-[11px] text-[color:var(--text-secondary)]",
                    "hover:bg-[var(--bg-hover)] transition-colors",
                  )}
                >
                  <Trash2 className="h-3 w-3" /> Clear all
                </button>
              </li>
            </ul>
          )}
        </section>
      )}

      {!stepping ? (
        <button
          type="button"
          onClick={handleStartTracking}
          disabled={!canStart}
          data-testid="sam-track-start"
          className={cn(
            // DESIGN.md §4 — primary CTA carries the full PS hover
            // signature: cyan fill + 2px white border + 2px PS-blue ring
            // + 1.05× lift, 180ms ease.
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full",
            "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
            "border border-[var(--accent)]",
            "transition-all duration-[180ms] ease-out",
            "hover:bg-[var(--accent-hover)] hover:border-white",
            "hover:shadow-[0_0_0_2px_var(--accent)] hover:scale-[1.05]",
            "active:opacity-60 active:scale-100",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
            "disabled:hover:scale-100 disabled:hover:border-[var(--border-subtle)] disabled:hover:bg-[var(--bg-subtle)] disabled:hover:shadow-none",
          )}
        >
          {starting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Start tracking
        </button>
      ) : (
        <button
          type="button"
          onClick={handleCancel}
          data-testid="sam-track-cancel"
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full",
            "bg-[var(--danger,oklch(0.7_0.2_25))] text-white font-medium",
            "hover:opacity-90 transition-opacity",
          )}
        >
          <X className="h-3.5 w-3.5" /> Cancel
        </button>
      )}

      {(stepping || framesPropagated > 0) && (
        <div className="grid gap-1">
          <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p
            data-testid="sam-track-progress"
            className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums"
          >
            {stepping
              ? `Tracking… ${framesPropagated} / ${totalFrames} frames (${progressPct}%)`
              : `Tracked ${framesPropagated} frames`}
          </p>
        </div>
      )}
    </aside>
  );
}

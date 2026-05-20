// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Loader2, Play, PlayCircle, Sparkles, Square, StopCircle, X } from "lucide-react";

import type { ClassRow } from "@/api/classes";
import { TrackTool } from "@/canvas/tools/TrackTool";
import { useTool } from "@/state/tool";
import { useTrackBridge } from "@/state/trackBridge";
import { useSamTrackBridge } from "@/state/samTrackBridge";
import { useAnnotations } from "@/state/annotations";
import { showToast } from "@/lib/toast";
import { Input } from "@/components/ui/Input";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

/** Default tracking window size (frames). SAM 3.1's start_session
 *  loads every frame into GPU memory and propagate_in_video allocates
 *  per-frame backbone features on top. With ONLY the multiplex
 *  tracker loaded (no image predictor coupling), 500 frames fits
 *  comfortably on a 24 GB GPU and 1 000 fits with the user's clip
 *  resolution at 720 × 1280 — confirmed working in earlier sessions. */
const DEFAULT_WINDOW = 500;
const MIN_WINDOW = 10;
/** Hard cap restored to 1 000 — the user previously propagated
 *  1 000-frame windows cleanly. Window prompts now use plain points
 *  (multiplex SAM2 path) and don't co-load the image predictor, so
 *  the GPU budget matches the historical working configuration. The
 *  propagate path still maps real OOM to HTTP 507 with a clear
 *  remediation hint if the user exceeds the GPU's actual capacity. */
const MAX_WINDOW = 1000;

interface TrackPanelProps {
  assetId: string;
  currentFrameIdx: number;
  totalFrames: number;
  classes: ClassRow[];
  frameIdxToFrameId: Record<number, string>;
}

export function TrackPanel({
  assetId, currentFrameIdx, totalFrames, classes, frameIdxToFrameId,
}: TrackPanelProps) {
  const status = useTrackBridge((s) => s.status);
  const objects = useTrackBridge((s) => s.objects);
  const framesPropagated = useTrackBridge((s) => s.framesPropagated);
  const sessionId = useTrackBridge((s) => s.sessionId);
  const autoTracking = useTrackBridge((s) => s.autoTracking);

  const confirm = useConfirm();

  const [running, setRunning] = useState(false);
  const [warming, setWarming] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Set true while a single click / box prompt is in flight so the
  // panel can render a "Processing click…" line. The first prompt
  // after a fresh session can take 2-5 s while torch compiles the
  // prompt path; silent waits look like the click was ignored.
  const [clicking, setClicking] = useState(false);

  // Tracking window — absolute asset frame indices (inclusive). Default
  // is a 500-frame window starting at the current frame, clamped to the
  // asset bounds. Editable by the user before opening the session.
  const lastFrame = Math.max(0, totalFrames - 1);
  const [startFrame, setStartFrame] = useState(() =>
    clamp(currentFrameIdx, 0, lastFrame),
  );
  const [endFrame, setEndFrame] = useState(() =>
    clamp(currentFrameIdx + DEFAULT_WINDOW - 1, 0, lastFrame),
  );
  const windowSize = Math.max(0, endFrame - startFrame + 1);
  const windowValid =
    startFrame >= 0
    && endFrame >= startFrame
    && endFrame <= lastFrame
    && windowSize >= MIN_WINDOW
    && windowSize <= MAX_WINDOW;
  const currentFrameInWindow =
    !!sessionId
    && currentFrameIdx >= startFrame
    && currentFrameIdx <= endFrame;

  // Live ref to the latest frame-idx → frame-id map so the tool's mask
  // commits always look up against the current map (the prop reference
  // changes when the frames query refetches).
  const frameMapRef = useRef(frameIdxToFrameId);
  frameMapRef.current = frameIdxToFrameId;
  const currentFrameIdxRef = useRef(currentFrameIdx);
  currentFrameIdxRef.current = currentFrameIdx;
  // Live refs to the open window bounds so the canvas-click closure
  // (registered ONCE in the bridge effect below) reads the current
  // values instead of capturing stale ones. Without this, the click
  // handler would always fire the API call and get a 422 when the
  // user was on a frame outside the open window.
  const startFrameRef = useRef(startFrame);
  startFrameRef.current = startFrame;
  const endFrameRef = useRef(endFrame);
  endFrameRef.current = endFrame;

  const toolRef = useRef<TrackTool | null>(null);
  if (toolRef.current === null) {
    toolRef.current = new TrackTool(
      assetId,
      () => useTool.getState().activeClassId,
      (frameIdx) => frameMapRef.current[frameIdx] ?? null,
    );
  }

  useEffect(() => {
    // No automatic close on unmount. The panel unmounts whenever the
    // user switches the editor tool (drag / bbox / etc.). If we closed
    // the session here, a Run-full-track in flight would be terminated
    // mid-propagation — that's exactly the "tracked 8 frames then
    // empty" symptom we hit before. The session lives until the user
    // explicitly clicks Discard / Close, or the model service's
    // 10-minute idle eviction reaps it. The TrackProgressBadge mounted
    // at the page level lets the user follow progress + jump back to
    // track mode at any time.
    return () => {};
  }, []);

  async function onOpenSession() {
    if (!windowValid || warming) return;
    setWarming(true);
    showToast(
      `Loading ${windowSize.toLocaleString()} frames into the SAM 3.1 model (~${Math.max(5, Math.round(windowSize / 50))}s on a 24 GB GPU). Hang tight — the canvas accepts clicks once it's ready.`,
      { variant: "info" },
    );
    try {
      await toolRef.current!.openSession({
        startFrame,
        endFrame,
      });
      showToast(
        `Tracking session ready on frames ${startFrame + 1}–${endFrame + 1}. Click on the canvas to seed objects.`,
        { variant: "success" },
      );
    } catch (err) {
      const e = err as {
        name?: string;
        code?: string;
        message?: string;
        response?: { status?: number; data?: { detail?: unknown } };
      };
      if (
        e?.name === "AbortError"
        || e?.name === "CanceledError"
        || e?.code === "ERR_CANCELED"
      ) return;
      if (e?.response?.status === 507) {
        const detail = typeof e?.response?.data?.detail === "string"
          ? e.response.data.detail
          : "GPU memory exhausted.";
        showToast(
          `GPU memory full — try a smaller window (under ${windowSize} frames) or wait for other tracking sessions to release. ${detail}`,
          { variant: "error" },
        );
        return;
      }
      showToast(`Track open failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setWarming(false);
    }
  }

  async function onCloseSession() {
    try {
      await toolRef.current!.closeSession();
    } catch (err) {
      showToast(`Close failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  /**
   * Chain the next window after a completed track. Closes the current
   * session, advances the [start, end] selector to [oldEnd + 1, oldEnd +
   * windowLen], and immediately opens that window. The user re-seeds
   * objects in the first frame of the new window — SAM 3.1 doesn't
   * support cross-session mask hand-off, so each window is its own
   * tracking run.
   */
  async function onTrackNextWindow() {
    if (running || warming || stopping) return;
    const previousEnd = endFrame;
    const previousLen = windowSize;
    const nextStart = previousEnd + 1;
    if (nextStart > lastFrame) {
      showToast(
        "This was the last window — you've covered the whole video.",
        { variant: "info" },
      );
      return;
    }
    const nextEnd = clamp(
      nextStart + previousLen - 1,
      nextStart,
      lastFrame,
    );
    try {
      await toolRef.current!.closeSession();
    } catch (err) {
      showToast(`Close failed: ${(err as Error).message}`, {
        variant: "error",
      });
      return;
    }
    setStartFrame(nextStart);
    setEndFrame(nextEnd);
    setWarming(true);
    const nextLen = nextEnd - nextStart + 1;
    showToast(
      `Opening next window: frames ${nextStart + 1}–${nextEnd + 1} (${nextLen.toLocaleString()} frames).`,
      { variant: "info" },
    );
    try {
      await toolRef.current!.openSession({
        startFrame: nextStart,
        endFrame: nextEnd,
      });
      showToast(
        `Window ${nextStart + 1}–${nextEnd + 1} ready. Re-seed objects on frame ${nextStart + 1} and click Run full track.`,
        { variant: "success" },
      );
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      if (
        e?.name === "AbortError"
        || e?.name === "CanceledError"
        || e?.code === "ERR_CANCELED"
      ) return;
      showToast(`Track open failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setWarming(false);
    }
  }

  /**
   * Chain windows automatically from the current open session to the
   * end of the video. The TrackTool snapshots end-frame masks per
   * tracked obj_id, converts each to a tight bbox, closes the current
   * session, opens the next window, re-seeds with those bboxes
   * (routed through SAM 3 detector for high-quality re-segmentation),
   * and propagates again.
   *
   * Triggered by the "Auto-track to end" button — visible only after
   * the first window finishes propagating successfully.
   */
  async function onAutoTrackToEnd() {
    const tool = toolRef.current;
    if (!tool) return;
    if (running || warming || stopping || autoTracking) return;
    const ok = await confirm({
      title: "Auto-track to end of video?",
      description: (
        <>
          The tracker will chain windows automatically until frame{" "}
          <span className="font-mono tabular-nums">{totalFrames}</span>.
          At each boundary it converts the last-frame masks into bboxes
          and seeds the next window — no manual re-seeding needed. You
          can click <strong>Stop</strong> at any time to halt; everything
          tracked so far stays saved.
        </>
      ),
      confirmLabel: `Auto-track ${(lastFrame - endFrame).toLocaleString()} more frames`,
      cancelLabel: "Cancel",
      variant: "default",
    });
    if (!ok) return;
    try {
      const summary = await tool.autoTrackToEnd({
        lastFrame,
        windowSize,
      });
      const reasonLabel: Record<typeof summary.reason, string> = {
        end_of_video: "reached the end of the video",
        canceled: "stopped",
        lost_objects: "lost track of all objects across 3 windows",
        gpu_exhausted: "ran out of GPU memory — reduce the window size and resume",
        error: "stopped due to an error",
      };
      const variant: "success" | "info" | "error" =
        summary.reason === "end_of_video"
          ? "success"
          : summary.reason === "gpu_exhausted"
            ? "error"
            : "info";
      showToast(
        `Auto-track ${reasonLabel[summary.reason]} after ${summary.windowsCompleted} window${summary.windowsCompleted === 1 ? "" : "s"} (${summary.framesTracked.toLocaleString()} frames covered).`,
        { variant },
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === "AbortError") return;
      showToast(`Auto-track failed: ${(err as Error).message}`, {
        variant: "error",
      });
    }
  }

  // v3.27 — register the canvas → TrackTool dispatch via samTrackBridge.
  // AnnotationCanvas reads onCanvasClick / onCanvasBox from this bridge in
  // pointerup. The handlers translate pixel coords + altKey into TrackTool
  // method calls. The "alt" arg comes from the canvas pointerup event.
  useEffect(() => {
    const bridge = useSamTrackBridge.getState();
    // v3.27.12 — silence cancellation errors. Even with the AbortSignal
    // gone from TrackTool, axios may surface ERR_CANCELED when a request
    // races a route change or session reset. Showing those as red toasts
    // taught the user to mistrust every click.
    const isCanceled = (err: unknown): boolean => {
      const e = err as { name?: string; code?: string; message?: string };
      return (
        e?.name === "AbortError"
        || e?.name === "CanceledError"
        || e?.code === "ERR_CANCELED"
        || (typeof e?.message === "string" && /cancel/i.test(e.message))
      );
    };
    const reportTrackError = (label: string, err: unknown) => {
      if (isCanceled(err)) return;
      const e = err as {
        response?: { status?: number; data?: { detail?: unknown } };
        message?: string;
      };
      const status = e?.response?.status;
      if (status === 507) {
        // GPU OOM — tell the user how to fix it, and clear the broken
        // session so the next attempt re-opens cleanly.
        const detail = typeof e?.response?.data?.detail === "string"
          ? e.response.data.detail
          : "GPU memory exhausted.";
        showToast(
          `GPU memory full — close this tracking session and reopen on a smaller window. ${detail}`,
          { variant: "error" },
        );
        void toolRef.current?.closeSession();
        return;
      }
      showToast(`${label}: ${(err as Error).message}`, {
        variant: "error",
      });
    };
    /** Returns false + toasts when the active click/box can't be sent. */
    function gateClick(tool: TrackTool): boolean {
      if (!tool.isActive()) {
        showToast(
          "Open a tracking session first (pick a frame range, then click \"Open session\").",
          { variant: "warning" },
        );
        return false;
      }
      if (tool.isRunning()) {
        showToast(
          "Tracking is propagating across the window — stop it first if you want to add a new object.",
          { variant: "warning" },
        );
        return false;
      }
      const frameIdx = currentFrameIdxRef.current;
      const winStart = startFrameRef.current;
      const winEnd = endFrameRef.current;
      if (frameIdx < winStart || frameIdx > winEnd) {
        showToast(
          `You're on frame ${frameIdx + 1}, outside the open session window (frames ${winStart + 1}–${winEnd + 1}). Scrub back into the range, or close this session and open a new one starting here.`,
          { variant: "warning" },
        );
        return false;
      }
      return true;
    }
    bridge.setHandler((point, negative) => {
      const tool = toolRef.current;
      if (!tool) return;
      if (!gateClick(tool)) return;
      setClicking(true);
      void tool.clickAt({
        frameIdx: currentFrameIdxRef.current,
        x: point[0],
        y: point[1],
        negative: negative ?? false,
      })
        .catch((err) => reportTrackError("Track click failed", err))
        .finally(() => setClicking(false));
    });
    bridge.setBoxHandler((box) => {
      const tool = toolRef.current;
      if (!tool) return;
      if (!gateClick(tool)) return;
      setClicking(true);
      void tool.dragBox({
        frameIdx: currentFrameIdxRef.current,
        box,
      })
        .catch((err) => reportTrackError("Track box failed", err))
        .finally(() => setClicking(false));
    });
    return () => {
      useSamTrackBridge.getState().clear();
    };
  }, []);

  const objectList = useMemo(
    () => Array.from(objects.values()).sort((a, b) => a.objId - b.objId),
    [objects],
  );

  async function onRunFull() {
    setRunning(true);
    showToast(
      `Propagating across frames ${startFrame + 1}–${endFrame + 1} (${windowSize.toLocaleString()} frames). This streams per-frame results — you'll see polygons land as it runs.`,
      { variant: "info" },
    );
    try {
      await toolRef.current!.runFullTrack();
      const done = useTrackBridge.getState().framesPropagated;
      showToast(
        `Tracking complete — ${done.toLocaleString()} frames covered in window ${startFrame + 1}–${endFrame + 1}.`,
        { variant: "success" },
      );
    } catch (err) {
      showToast(`Tracking failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setRunning(false);
    }
  }

  async function onStopSession() {
    // Stop the tracking session WITHOUT deleting annotations. Aborts
    // any in-flight propagation and closes the session — every polygon
    // already committed during the run stays in the database. Confirms
    // via the app's ConfirmDialog primitive (consistent with the rest
    // of the UI) instead of the browser's native popup.
    const tool = toolRef.current;
    if (!tool) return;
    const obj = useTrackBridge.getState().objects.size;
    const wasRunning = tool.isRunning();
    const ok = await confirm({
      title: "Stop tracking session?",
      description: (
        <>
          {wasRunning
            ? "This will halt the in-flight propagation and close the session."
            : "This will close the current tracking session."}
          {" "}Every polygon already tracked{" "}
          <span className="font-medium text-[color:var(--text-primary)]">
            stays saved
          </span>{" "}
          on the asset — nothing is deleted.
          {obj > 0 && (
            <>
              {" "}You currently have{" "}
              <span className="font-mono tabular-nums">
                {obj}
              </span>{" "}
              seeded object{obj === 1 ? "" : "s"} in this window.
            </>
          )}
        </>
      ),
      confirmLabel: "Stop session",
      cancelLabel: "Keep tracking",
      variant: "danger",
    });
    if (!ok) return;
    setStopping(true);
    try {
      // Explicitly cancel the auto-track loop FIRST so its in-flight
      // iteration sees the flag and bails — closeSession alone no
      // longer flips ``autoTrackCanceled`` because the loop itself
      // uses closeSession between windows.
      tool.cancelAutoTrack();
      await tool.closeSession();
      showToast(
        "Tracking session stopped. Polygons are kept.",
        { variant: "success" },
      );
    } catch (err) {
      showToast(`Stop failed: ${(err as Error).message}`, {
        variant: "error",
      });
    } finally {
      setStopping(false);
    }
  }

  // Cap display value at the window size. ``framesPropagated`` can
  // momentarily exceed ``windowSize`` if a previous larger window's
  // count lingers, or if the model emits a duplicate at the boundary;
  // showing "907 / 500 (100%)" reads as broken UI.
  const displayedFrames = Math.max(
    0, Math.min(framesPropagated, windowSize),
  );
  const progressPct =
    windowSize > 0
      ? Math.min(100, Math.round((displayedFrames / windowSize) * 100))
      : 0;

  return (
    <aside
      role="complementary"
      aria-label="SAM 3.1 video tracking"
      data-testid="track-panel"
      className={cn(
        "flex flex-col gap-3 p-3 border-t border-[var(--glass-border)]",
        "glass-surface text-[12.5px]",
        // v3.27.12 — clamp panel height so a multi-object track doesn't
        // push the textbox / Run button off-screen. The object list
        // inside has its own max-height + scroll already; this is the
        // outer guard against the whole panel exceeding the right rail.
        "max-h-[60vh] overflow-y-auto shrink-0",
      )}
    >
      <header className="flex items-center justify-between">
        <span className="font-medium">Track</span>
        <span className="font-mono tabular-nums text-[10.5px] text-[color:var(--text-tertiary)]">
          Frame {currentFrameIdx + 1} / {totalFrames}
        </span>
      </header>

      {!sessionId && (
        <div
          data-testid="track-window-editor"
          className="flex flex-col gap-2 rounded-md border border-[var(--glass-border)] bg-[var(--bg-sunken)]/40 p-2"
        >
          <p className="text-[11px] text-[color:var(--text-secondary)] leading-snug">
            SAM 3.1 loads every window frame into GPU memory. Pick a
            range (max {MAX_WINDOW.toLocaleString()} frames).
            {totalFrames > MAX_WINDOW && (
              <>
                {" "}This video has{" "}
                <span className="font-mono tabular-nums">{totalFrames.toLocaleString()}</span>{" "}
                frames — track this window, then click{" "}
                <em>Track next window</em> to continue.
              </>
            )}
          </p>
          <div className="flex items-center gap-1.5">
            <label
              className="text-[10.5px] uppercase tracking-wide text-[color:var(--text-tertiary)] w-9"
              htmlFor="track-window-start"
            >
              From
            </label>
            <Input
              id="track-window-start"
              type="number"
              min={0}
              max={lastFrame}
              data-testid="track-window-start"
              value={startFrame + 1}
              onChange={(e) => {
                const v = clamp(
                  Number.parseInt(e.target.value || "0", 10) - 1,
                  0,
                  lastFrame,
                );
                setStartFrame(Number.isFinite(v) ? v : 0);
              }}
              className="h-7 w-20 font-mono tabular-nums text-[11px]"
            />
            <label
              className="text-[10.5px] uppercase tracking-wide text-[color:var(--text-tertiary)] w-5"
              htmlFor="track-window-end"
            >
              to
            </label>
            <Input
              id="track-window-end"
              type="number"
              min={0}
              max={lastFrame}
              data-testid="track-window-end"
              value={endFrame + 1}
              onChange={(e) => {
                const v = clamp(
                  Number.parseInt(e.target.value || "0", 10) - 1,
                  0,
                  lastFrame,
                );
                setEndFrame(Number.isFinite(v) ? v : 0);
              }}
              className="h-7 w-20 font-mono tabular-nums text-[11px]"
            />
            <span
              className={cn(
                "text-[10.5px] font-mono tabular-nums",
                windowValid
                  ? "text-[color:var(--text-tertiary)]"
                  : "text-[color:var(--accent-danger)]",
              )}
              data-testid="track-window-size"
            >
              {windowSize.toLocaleString()} frames
            </span>
          </div>
          {!windowValid && (
            <p className="text-[11px] text-[color:var(--accent-danger)]">
              Pick a range with {MIN_WINDOW}–{MAX_WINDOW.toLocaleString()} frames
              within [1, {totalFrames.toLocaleString()}].
            </p>
          )}
          <button
            type="button"
            data-testid="track-open-session"
            disabled={!windowValid || warming}
            onClick={() => void onOpenSession()}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-full",
              "bg-[var(--accent)] text-[color:var(--accent-fg)] text-[11.5px] font-medium",
              "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
            )}
          >
            {warming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlayCircle className="h-3.5 w-3.5" />
            )}
            {warming ? "Loading frames into model…" : "Open tracking session"}
          </button>
        </div>
      )}

      {sessionId && (
        <div
          data-testid="track-session-summary"
          className="flex items-center justify-between text-[11px] text-[color:var(--text-secondary)] rounded-md border border-[var(--glass-border)] bg-[var(--bg-sunken)]/40 px-2 py-1.5"
        >
          <span>
            Session live on frames{" "}
            <span className="font-mono tabular-nums">
              {startFrame + 1}–{endFrame + 1}
            </span>{" "}
            ({windowSize.toLocaleString()} frames)
          </span>
          <button
            type="button"
            data-testid="track-close-session"
            disabled={running}
            onClick={() => void onCloseSession()}
            title={
              running
                ? "Stop tracking first, then close the session."
                : "Close this tracking session and free the GPU. Already-saved polygons stay."
            }
            className="inline-flex items-center justify-center gap-1 h-6 px-2 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[10.5px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <StopCircle className="h-3 w-3" /> Close
          </button>
        </div>
      )}

      {sessionId && !currentFrameInWindow && (
        <p
          data-testid="track-frame-outside-window"
          className="text-[11px] text-[color:var(--accent-danger)]"
        >
          You are on frame {currentFrameIdx + 1}, outside the open session
          window. Scrub back into the range or close and reopen on a new
          window.
        </p>
      )}

      {sessionId && currentFrameInWindow && objectList.length === 0 && (
        <p className="text-[11px] text-[color:var(--text-secondary)]">
          Left-click on canvas to seed. Click an existing mask to refine.
          Right-click for negative.
        </p>
      )}

      {objectList.length > 0 && (
        <ul
          data-testid="track-object-list"
          className="grid gap-1 max-h-[180px] overflow-y-auto pr-1 -mr-1"
        >
          {objectList.map((o) => {
            const cls = classes.find((c) => c.id === o.classId);
            const currentFrameId = frameIdxToFrameId[currentFrameIdx];
            const tempIdOnFrame = currentFrameId
              ? `track:${useTrackBridge.getState().trackIds.get(o.objId)}:${currentFrameId}`
              : null;
            const hasMaskOnCurrentFrame = tempIdOnFrame
              ? !!useAnnotations.getState().byId[tempIdOnFrame]
              : false;
            return (
              <li
                key={o.objId}
                data-testid={`track-object-${o.objId}`}
                className="flex items-center gap-1.5 text-[11.5px]"
              >
                <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] w-5">
                  #{o.objId}
                </span>
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: cls?.color ?? "#888" }}
                />
                <span className="flex-1 truncate">{cls?.name ?? o.classId}</span>
                <span className="text-[10px] text-[color:var(--text-tertiary)]">
                  ▸ frame {o.seedFrame}
                </span>
                {/* v3.27.5 — per-frame remove. Drops the polygon for
                    this obj on the CURRENT frame only; the obj stays
                    registered so propagation / refinement on other
                    frames is preserved. The X button below still
                    removes the obj across the whole video. */}
                <button
                  type="button"
                  data-testid={`track-remove-on-frame-${o.objId}`}
                  disabled={!hasMaskOnCurrentFrame || running}
                  onClick={() => {
                    if (!tempIdOnFrame) return;
                    useAnnotations.getState().remove(tempIdOnFrame);
                  }}
                  className="ml-1 inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={`Remove object ${o.objId} on frame ${currentFrameIdx + 1}`}
                  title={
                    running
                      ? "Stop tracking first."
                      : `Remove from frame ${currentFrameIdx + 1}`
                  }
                >
                  <Eraser className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid={`track-remove-${o.objId}`}
                  disabled={running}
                  onClick={() => void toolRef.current!.removeObject(o.objId)}
                  className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={`Remove object ${o.objId} entirely`}
                  title={running ? "Stop tracking first." : "Remove from all frames"}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {clicking && (
        <p
          data-testid="track-clicking"
          className="flex items-center gap-2 text-[11px] text-[color:var(--text-secondary)]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Processing click — running the SAM 3.1 prompt on this frame…
        </p>
      )}

      {sessionId && endFrame < lastFrame && !running && !warming && (() => {
        const remaining = lastFrame - endFrame;
        const nextStart = endFrame + 1;
        const nextEnd = Math.min(endFrame + windowSize, lastFrame);
        const nextLen = nextEnd - nextStart + 1;
        const windowsLeft = Math.ceil(remaining / windowSize);
        return (
          <div
            data-testid="track-next-window-cta"
            className="flex flex-col gap-1.5 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 p-2"
          >
            <p className="text-[11px] text-[color:var(--text-secondary)] leading-snug">
              <strong className="text-[color:var(--text-primary)]">
                {remaining.toLocaleString()} frames left
              </strong>
              {" after this window. To cover the whole video, finish "
                + "this window, then click \"Track next window\"."}
              {windowsLeft > 1 && (
                <>
                  {" "}Roughly{" "}
                  <span className="font-mono tabular-nums">
                    {windowsLeft}
                  </span>{" "}
                  more window{windowsLeft === 1 ? "" : "s"} to go.
                </>
              )}
            </p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="track-next-window"
                onClick={() => void onTrackNextWindow()}
                disabled={
                  (objects.size === 0 && status === "idle") || autoTracking
                }
                title={
                  objects.size === 0 && status === "idle"
                    ? "Track this window first, then continue."
                    : `Close this session and open ${nextStart + 1}–${nextEnd + 1} (${nextLen.toLocaleString()} frames). You will need to re-seed the objects.`
                }
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-full",
                  "bg-[var(--accent)] text-[color:var(--accent-fg)] text-[11.5px] font-medium",
                  "hover:opacity-90",
                  "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
                )}
              >
                <PlayCircle className="h-3.5 w-3.5" />
                Track next window ({nextStart + 1}–{nextEnd + 1})
              </button>
              {/* Hands-off path: chain windows automatically until the
                  end of the video. Visible only after the first window
                  finishes successfully (status === "done") so the user
                  has a known-good seed to hand off from. */}
              {status === "done" && objects.size > 0 && (
                <button
                  type="button"
                  data-testid="track-auto-to-end"
                  onClick={() => void onAutoTrackToEnd()}
                  disabled={autoTracking}
                  title={
                    autoTracking
                      ? "Auto-tracking already in progress."
                      : `Chain ${windowsLeft} window${windowsLeft === 1 ? "" : "s"} automatically to cover frames ${nextStart + 1}–${(lastFrame + 1).toLocaleString()}. Each window's last-frame masks become the next window's seeds (bbox → SAM 3 detector). Click Stop to halt.`
                  }
                  className={cn(
                    "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-full",
                    "bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11.5px] font-medium",
                    "border border-[color:var(--accent)]/30",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Auto-track to end ({windowsLeft} window{windowsLeft === 1 ? "" : "s"})
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {autoTracking && (
        <div
          data-testid="track-auto-tracking-indicator"
          className="flex items-center gap-2 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-2 py-1.5 text-[11px] text-[color:var(--text-secondary)]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
          Auto-tracking in progress — click <strong>Stop</strong> to halt.
          Already-tracked polygons stay saved.
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="track-run"
          disabled={objects.size === 0 || running || stopping || warming}
          onClick={() => void onRunFull()}
          title={
            running
              ? "Propagation already in flight — use Stop if you want to interrupt."
              : "Run SAM 3.1 propagation across the open session window"
          }
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full",
            "bg-[var(--accent)] text-[color:var(--accent-fg)] font-medium",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
          )}
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {running
            ? `Propagating ${displayedFrames} / ${windowSize}…`
            : "Run full track"}
        </button>
        <button
          type="button"
          data-testid="track-stop-session"
          disabled={stopping}
          onClick={() => void onStopSession()}
          title="Stop this tracking session (and any in-flight propagation). Already-tracked polygons stay on the asset — nothing is deleted."
          className={cn(
            "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-full text-[11.5px]",
            running
              ? "bg-[color:var(--accent-danger)] text-white font-medium hover:opacity-90"
              : "bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)]",
            "disabled:opacity-50",
          )}
        >
          {stopping ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>

      {(status === "running" || framesPropagated > 0) && (
        <div className="grid gap-1">
          <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[11px] text-[color:var(--text-tertiary)] tabular-nums">
            Tracked {displayedFrames} / {windowSize} ({progressPct}%)
          </p>
        </div>
      )}

    </aside>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

// Armin Mehri — mehri.armin@gmail.com
import { ArrowLeftCircle, Loader2, Radio } from "lucide-react";

import { useTool } from "@/state/tool";
import { useTrackBridge } from "@/state/trackBridge";

/**
 * Persistent floating chip for the SAM 3.1 video tracking session.
 *
 * Mounts at the page level so it survives the user switching tools
 * mid-session — switching to Drag/Bbox/etc. unmounts the right-rail
 * TrackPanel, but a session may still be live (and propagation may
 * still be streaming) on the model service. Without this badge users
 * lose all sight of an in-progress track and end up opening another
 * session by accident.
 *
 * Three visual states:
 *   1. ``status === "running"`` — propagation streaming; show
 *      "Tracking N / M frames (X %)".
 *   2. ``sessionId != null`` and the user is NOT in track mode —
 *      show "Tracking session live — N seeded objects" + a "Back to
 *      Track" button that re-enters track mode.
 *   3. Otherwise — render nothing.
 */
export function TrackProgressBadge() {
  const status = useTrackBridge((s) => s.status);
  const propagated = useTrackBridge((s) => s.framesPropagated);
  const total = useTrackBridge((s) => s.totalFrames);
  const sessionId = useTrackBridge((s) => s.sessionId);
  const objects = useTrackBridge((s) => s.objects);
  const autoTracking = useTrackBridge((s) => s.autoTracking);
  const autoCompletedWindows = useTrackBridge((s) => s.autoCompletedWindows);
  const autoTotalWindows = useTrackBridge((s) => s.autoTotalWindows);
  const autoLastFrame = useTrackBridge((s) => s.autoLastFrame);

  const tool = useTool((s) => s.active);
  const samMode = useTool((s) => s.samMode);
  const inTrackMode = tool === "sam" && samMode === "track";

  const running = status === "running";
  const sessionLive = sessionId != null;

  // Nothing useful to show: no live session, no propagation, no
  // auto-track loop.
  if (!running && !sessionLive && !autoTracking) return null;
  // Hide when the user is in track mode AND nothing is in flight — the
  // right-rail TrackPanel already shows the session summary there.
  // Auto-tracking ALWAYS shows the badge so the user sees video-wide
  // progress even from inside the track panel.
  if (inTrackMode && !running && !autoTracking) return null;

  const pct = total > 0
    ? Math.min(100, Math.round((propagated / total) * 100))
    : 0;

  // Auto-track progress: completed-windows / total-windows.
  const autoPct =
    autoTotalWindows > 0
      ? Math.min(
          100,
          Math.round((autoCompletedWindows / autoTotalWindows) * 100),
        )
      : 0;

  function jumpBack(): void {
    const t = useTool.getState();
    t.setActive("sam");
    t.setSamMode("track");
  }

  if (autoTracking) {
    const inflightWindow = Math.min(
      autoCompletedWindows + (running ? 1 : 0),
      autoTotalWindows,
    );
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="track-auto-track-badge"
        className="
          fixed bottom-4 right-4 z-50
          flex items-center gap-2
          px-3 py-2 rounded-full
          bg-[var(--bg-elevated)] glass-surface-strong
          border border-[var(--glass-border)]
          text-[12px] font-medium tabular-nums
          shadow-lg
        "
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
        <span>
          Auto-track window {inflightWindow} / {autoTotalWindows}
        </span>
        <span className="text-[color:var(--text-tertiary)]">
          ({autoPct}%
          {autoLastFrame > 0
            ? ` · up to frame ${autoLastFrame + 1}`
            : ""})
        </span>
        {running && total > 0 && (
          <span className="text-[color:var(--text-tertiary)]">
            · this window {propagated.toLocaleString()} / {total.toLocaleString()}
          </span>
        )}
        {!inTrackMode && (
          <button
            type="button"
            data-testid="track-auto-back"
            onClick={jumpBack}
            title="Switch back to Track mode"
            className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] text-[color:var(--text-primary)]"
          >
            <ArrowLeftCircle className="h-3 w-3" /> Back to Track
          </button>
        )}
      </div>
    );
  }

  if (running) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="track-progress-badge"
        className="
          fixed bottom-4 right-4 z-50
          flex items-center gap-2
          px-3 py-2 rounded-full
          bg-[var(--bg-elevated)] glass-surface-strong
          border border-[var(--glass-border)]
          text-[12px] font-medium tabular-nums
          shadow-lg
        "
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
        <span>
          Tracking {propagated.toLocaleString()} / {total.toLocaleString()}
        </span>
        <span className="text-[color:var(--text-tertiary)]">({pct}%)</span>
        {!inTrackMode && (
          <button
            type="button"
            data-testid="track-progress-back"
            onClick={jumpBack}
            title="Switch back to Track mode"
            className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] text-[color:var(--text-primary)]"
          >
            <ArrowLeftCircle className="h-3 w-3" /> Back to Track
          </button>
        )}
      </div>
    );
  }

  // sessionLive && !running && !inTrackMode
  const objectCount = objects.size;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="track-session-badge"
      className="
        fixed bottom-4 right-4 z-50
        flex items-center gap-2
        px-3 py-2 rounded-full
        bg-[var(--bg-elevated)] glass-surface-strong
        border border-[var(--glass-border)]
        text-[12px] font-medium
        shadow-lg
      "
    >
      <Radio className="h-3.5 w-3.5 text-[var(--accent)]" />
      <span>Tracking session live</span>
      <span className="text-[color:var(--text-tertiary)] tabular-nums">
        {objectCount === 0
          ? "no seeds yet"
          : `${objectCount} seeded object${objectCount === 1 ? "" : "s"}`}
      </span>
      <button
        type="button"
        data-testid="track-session-back"
        onClick={jumpBack}
        title="Switch back to Track mode"
        className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[11px] text-[color:var(--text-primary)]"
      >
        <ArrowLeftCircle className="h-3 w-3" /> Back to Track
      </button>
    </div>
  );
}

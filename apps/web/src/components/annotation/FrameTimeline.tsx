import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorSettings, type PlayerSpeed } from "@/state/editorSettings";

interface Props {
  totalFrames: number;
  currentIdx: number;
  onChange: (idx: number) => void;
}

/** Map the user's "Player speed" preference to a per-frame interval in ms.
 * Used by the spacebar play loop. */
function speedToIntervalMs(speed: PlayerSpeed): number {
  switch (speed) {
    case "slowest":
      return 2000;
    case "slow":
      return 1500;
    case "fast":
      return 500;
    case "fastest":
      return 250;
    case "usual":
    default:
      return 1000;
  }
}

export function FrameTimeline({ totalFrames, currentIdx, onChange }: Props) {
  const playingRef = useRef<number | null>(null);
  // playerStep / playerSpeed are personal preferences — read directly from
  // the store inside the keydown handler so changes apply on the very next
  // keypress without re-binding.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const settings = useEditorSettings.getState();
      const step = Math.max(1, Math.round(settings.playerStep));
      // v3.8 Phase 4-video step F3 — accept `,` and `.` as alternate
      // frame-step shortcuts (matches video-editor convention) along
      // with the legacy `[` / `]`.
      // v3.8 Phase 4-video step F8 — ArrowLeft/Right step frames on video
      // assets too (matches the user's mental model: arrows = navigate
      // the visible frame). Asset navigation moves to Shift+Arrow.
      const plainArrowLeft =
        e.key === "ArrowLeft" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey;
      const plainArrowRight =
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey;
      if (e.key === "[" || e.key === "," || plainArrowLeft) {
        if (plainArrowLeft) {
          e.preventDefault();
          e.stopPropagation();
        }
        onChange(Math.max(0, currentIdx - step));
      } else if (e.key === "]" || e.key === "." || plainArrowRight) {
        if (plainArrowRight) {
          e.preventDefault();
          e.stopPropagation();
        }
        onChange(Math.min(totalFrames - 1, currentIdx + step));
      } else if (e.key === " ") {
        e.preventDefault();
        if (playingRef.current !== null) {
          window.clearInterval(playingRef.current);
          playingRef.current = null;
        } else {
          const interval = speedToIntervalMs(settings.playerSpeed);
          playingRef.current = window.setInterval(() => {
            onChange(Math.min(totalFrames - 1, currentIdx + step));
          }, interval);
        }
      }
    }
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (playingRef.current !== null) {
        window.clearInterval(playingRef.current);
        playingRef.current = null;
      }
    };
  }, [currentIdx, totalFrames, onChange]);

  if (totalFrames <= 1) return null;
  const max = totalFrames - 1;
  return (
    <div
      role="group"
      aria-label="Frame timeline"
      className={cn(
        "flex h-[48px] w-full items-center gap-2 px-3 py-2",
        "border-t border-[var(--border-subtle)]",
        "bg-[var(--glass-bg-strong)] backdrop-blur-xl",
      )}
    >
      {/* v3.8 Phase 4-video step F3 — visible prev/next buttons.
           Keyboard equivalents: ArrowLeft / [ / ,  →  prev;
                                 ArrowRight / ] / .  →  next.
           Shift+Arrow navigates between assets (handled in the page). */}
      <button
        type="button"
        aria-label="Previous frame"
        title="Previous frame (← or [ or ,)"
        onClick={() =>
          onChange(
            Math.max(
              0,
              currentIdx -
                Math.max(1, Math.round(useEditorSettings.getState().playerStep)),
            ),
          )
        }
        disabled={currentIdx === 0}
        data-testid="frame-prev"
        className={cn(
          "grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] shrink-0",
          "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "transition-colors",
        )}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Next frame"
        title="Next frame (→ or ] or .)"
        onClick={() =>
          onChange(
            Math.min(
              max,
              currentIdx +
                Math.max(1, Math.round(useEditorSettings.getState().playerStep)),
            ),
          )
        }
        disabled={currentIdx >= max}
        data-testid="frame-next"
        className={cn(
          "grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] shrink-0",
          "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "transition-colors",
        )}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      {/* Native range slider — collapses to the available width regardless
          of frame count, so a 500-frame video doesn't push the strip off
          screen. The visible track is styled with currentColor for the
          active accent. */}
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={currentIdx}
        aria-label="Frame slider"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={currentIdx}
        data-testid="frame-slider"
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "flex-1 h-1.5 cursor-pointer appearance-none rounded-full",
          "bg-[var(--border-strong)] outline-none",
          "accent-[var(--accent)]",
          "[&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5",
          "[&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-[var(--accent)]",
          "[&::-webkit-slider-thumb]:shadow-[0_0_6px_oklch(0.78_0.16_215_/_0.55)]",
          "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5",
          "[&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:border-none",
          "[&::-moz-range-thumb]:bg-[var(--accent)]",
        )}
      />
      <span
        data-testid="frame-counter"
        className="font-mono-data text-[10.5px] text-tertiary tabular-tight shrink-0 min-w-[68px] text-right"
      >
        {currentIdx + 1} / {totalFrames}
      </span>
    </div>
  );
}

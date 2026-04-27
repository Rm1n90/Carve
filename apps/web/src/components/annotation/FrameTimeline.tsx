import { useEffect, useRef } from "react";
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
      if (e.key === "[") {
        onChange(Math.max(0, currentIdx - step));
      } else if (e.key === "]") {
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
  return (
    <div
      role="slider"
      aria-label="Frame timeline"
      aria-valuemin={0}
      aria-valuemax={totalFrames - 1}
      aria-valuenow={currentIdx}
      className={cn(
        "flex h-[60px] items-center gap-px overflow-x-auto px-3 py-2",
        "border-t border-[var(--border-subtle)]",
        "bg-[var(--bg-glass-strong)] backdrop-blur-xl",
      )}
    >
      <span className="font-mono-data text-[10px] text-tertiary mr-3 shrink-0">
        {currentIdx + 1} / {totalFrames}
      </span>
      {Array.from({ length: totalFrames }).map((_, i) => (
        <button
          key={i}
          onClick={() => onChange(i)}
          aria-label={`Go to frame ${i}`}
          aria-current={i === currentIdx}
          className={cn(
            "shrink-0 transition-all",
            i === currentIdx
              ? "h-9 w-1 bg-[var(--accent)] shadow-[0_0_8px_oklch(0.78_0.16_215_/_0.6)]"
              : "h-6 w-[3px] bg-[var(--border-strong)] hover:bg-[var(--accent)] hover:h-7",
          )}
        />
      ))}
    </div>
  );
}

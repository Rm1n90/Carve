import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

interface Props {
  totalFrames: number;
  currentIdx: number;
  onChange: (idx: number) => void;
}

export function FrameTimeline({ totalFrames, currentIdx, onChange }: Props) {
  const playingRef = useRef<number | null>(null);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "[") {
        onChange(Math.max(0, currentIdx - 1));
      } else if (e.key === "]") {
        onChange(Math.min(totalFrames - 1, currentIdx + 1));
      } else if (e.key === " ") {
        e.preventDefault();
        if (playingRef.current !== null) {
          window.clearInterval(playingRef.current);
          playingRef.current = null;
        } else {
          playingRef.current = window.setInterval(() => {
            onChange(Math.min(totalFrames - 1, currentIdx + 1));
          }, 1000);
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

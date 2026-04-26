import { useEffect, useRef } from "react";

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
            // Capture current via the prop; advance until last frame, then stop
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
      style={{
        display: "flex",
        gap: 1,
        padding: 8,
        borderTop: "1px solid rgba(255,255,255,0.1)",
        background: "rgba(255,255,255,0.02)",
        overflowX: "auto",
      }}
    >
      {Array.from({ length: totalFrames }).map((_, i) => (
        <button
          key={i}
          onClick={() => onChange(i)}
          aria-label={`Go to frame ${i}`}
          aria-current={i === currentIdx}
          style={{
            flex: "0 0 auto",
            width: 4,
            height: 24,
            background: i === currentIdx ? "rgba(120,200,255,0.9)" : "rgba(255,255,255,0.18)",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        />
      ))}
    </div>
  );
}

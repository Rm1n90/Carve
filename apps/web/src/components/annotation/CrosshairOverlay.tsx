// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { useEditorSettings } from "@/state/editorSettings";

interface Props {
  hostRef: RefObject<HTMLDivElement | null>;
  /** Convert host-relative pixel position into image-space coords. */
  toImageXY: (clientX: number, clientY: number) => { x: number; y: number };
  /** Show or hide. Toggled from the visibility dropdown. */
  enabled: boolean;
}

/**
 * Absolutely-positioned overlay that draws a CVAT / Ultralytics-style
 * crosshair at the pointer (white dashed lines via the CSS
 * ``border-dashed`` browser default). The optional ``x: __ y: __``
 * chip is gated by the ``showCrosshairReadout`` editor setting (off
 * by default).
 */
export function CrosshairOverlay({ hostRef, toImageXY, enabled }: Props) {
  const showReadout = useEditorSettings((s) => s.showCrosshairReadout);
  const [pos, setPos] = useState<{ cx: number; cy: number; ix: number; iy: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) {
      setPos(null);
      return;
    }
    function move(e: PointerEvent) {
      const rect = host!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { x, y } = toImageXY(e.clientX, e.clientY);
      setPos({ cx, cy, ix: Math.round(x), iy: Math.round(y) });
    }
    function leave() {
      setPos(null);
    }
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, [hostRef, toImageXY, enabled]);

  if (!enabled || !pos) return null;

  return (
    <div
      data-testid="crosshair-overlay"
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 select-none"
    >
      {/*
       * CVAT / Ultralytics-style guide: white dashed lines that follow
       * the pointer for pixel-precise bbox alignment. Border-based
       * rendering keeps the element zero-sized so only the 1px dashed
       * stroke is visible. A subtle black shadow keeps the dashes
       * legible on light backdrops without overpowering them on dark.
       */}
      <span
        className="absolute top-0 bottom-0 w-0 border-l border-dashed border-white"
        style={{
          left: `${pos.cx}px`,
          filter: "drop-shadow(0 0 1px rgba(0,0,0,0.6))",
        }}
      />
      <span
        className="absolute left-0 right-0 h-0 border-t border-dashed border-white"
        style={{
          top: `${pos.cy}px`,
          filter: "drop-shadow(0 0 1px rgba(0,0,0,0.6))",
        }}
      />
      {showReadout ? (
        <span
          className={cn(
            "absolute px-1.5 py-0.5 rounded-[var(--radius-xs)]",
            "glass-tooltip",
            "text-[11px] tabular-nums font-mono text-[color:var(--text-primary)]",
          )}
          style={{
            left: `${pos.cx + 12}px`,
            top: `${pos.cy + 12}px`,
          }}
        >
          x: {pos.ix} y: {pos.iy}
        </span>
      ) : null}
    </div>
  );
}

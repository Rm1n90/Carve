// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";

interface Props {
  hostRef: RefObject<HTMLDivElement | null>;
  /** Convert host-relative pixel position into image-space coords. */
  toImageXY: (clientX: number, clientY: number) => { x: number; y: number };
  /** Show or hide. Toggled from the visibility dropdown. */
  enabled: boolean;
}

/**
 * Absolutely-positioned overlay that draws a crosshair at the pointer with
 * a small monospace x/y readout. Uses normal DOM (simpler than Pixi).
 */
export function CrosshairOverlay({ hostRef, toImageXY, enabled }: Props) {
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
      <span
        className="absolute top-0 bottom-0 w-px bg-[rgba(99,102,241,0.65)]"
        style={{ left: `${pos.cx}px` }}
      />
      <span
        className="absolute left-0 right-0 h-px bg-[rgba(99,102,241,0.65)]"
        style={{ top: `${pos.cy}px` }}
      />
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
    </div>
  );
}

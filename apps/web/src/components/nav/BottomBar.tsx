import type { ReactNode } from "react";
import { Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface BottomBarProps {
  thumbnailUrl?: string;
  filename: string;
  width: number;
  height: number;
  zoomPct: number;
  rightAction?: ReactNode;
}

/**
 * Editor footer — 40px tall white bar. Centered: thumbnail + filename +
 * dimensions (mono) + zoom % (mono). Right slot for help/AI pill.
 */
export function BottomBar({
  thumbnailUrl,
  filename,
  width,
  height,
  zoomPct,
  rightAction,
}: BottomBarProps) {
  return (
    <footer
      className={cn(
        "h-10 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3",
        "border-t border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
      <span aria-hidden />

      <div className="flex items-center gap-2 min-w-0">
        <span className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] border border-[var(--border-subtle)] overflow-hidden shrink-0">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <ImageIcon className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
          )}
        </span>
        <span className="text-[12.5px] text-[color:var(--text-primary)] tracking-tight truncate max-w-[260px]">
          {filename}
        </span>
        <span className="font-mono text-[11px] text-[color:var(--text-tertiary)] tabular-tight whitespace-nowrap">
          {width} × {height}
        </span>
        <span aria-hidden className="text-[color:var(--text-tertiary)]">·</span>
        <span className="font-mono text-[11px] text-[color:var(--text-tertiary)] tabular-tight whitespace-nowrap">
          {zoomPct.toFixed(1)}%
        </span>
      </div>

      <div className="flex items-center justify-end">{rightAction}</div>
    </footer>
  );
}

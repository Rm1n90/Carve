// Armin Mehri — mehri.armin@gmail.com
import { useMemo } from "react";
import { X } from "lucide-react";

import { useAnnotations } from "@/state/annotations";
import { cn } from "@/lib/cn";

/**
 * Tiny floating badge surfaced over the canvas when more than one
 * annotation is selected. Tells the user the multi-select shortcut
 * worked and how to act on it.
 *
 * v2.7 wave 2 item 4 - without this hint the user can't tell that
 * shift-click / Cmd+A actually selected several boxes; the existing
 * canvas selection visuals don't include a count.
 *
 * v3.27.11 — extended:
 *   * "here / elsewhere" split when ``frameId`` is supplied so a
 *     cross-frame multi-selection is visible (the canvas only paints
 *     polygons whose frameId matches the active frame, so off-frame
 *     selections were silently invisible).
 *   * class-count chip when the selection spans multiple classes.
 *   * an inline X button to clear the selection without leaving the
 *     canvas (Escape still works too).
 */
export function SelectionCountBadge({
  frameId = null,
}: { frameId?: string | null } = {}) {
  const byId = useAnnotations((s) => s.byId);
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const clearSelection = useAnnotations((s) => s.clearSelection);

  const stats = useMemo(() => {
    let here = 0;
    let elsewhere = 0;
    const classIds = new Set<string>();
    for (const id of selectedIds) {
      const a = byId[id];
      if (!a) continue;
      classIds.add(a.classId);
      if (frameId != null && a.frameId === frameId) here += 1;
      else if (frameId != null) elsewhere += 1;
    }
    return { here, elsewhere, classes: classIds.size };
  }, [byId, selectedIds, frameId]);

  const count = selectedIds.length;
  if (count <= 1) return null;

  return (
    <div
      data-testid="selection-count-badge"
      aria-live="polite"
      className={cn(
        "absolute top-2 left-2 z-20",
        "inline-flex items-center gap-2 px-2.5 h-7 rounded-full",
        "glass-tooltip",
        "text-[11.5px] font-medium tracking-tight tabular-tight",
        "text-[color:var(--text-secondary)]",
      )}
    >
      <span className="text-[color:var(--text-primary)]">{count}</span>
      <span className="opacity-70">selected</span>
      {frameId != null && stats.elsewhere > 0 && (
        <>
          <span className="opacity-40">·</span>
          <span className="opacity-80">{stats.here} here</span>
          <span className="opacity-40">·</span>
          <span className="opacity-80">{stats.elsewhere} elsewhere</span>
        </>
      )}
      {stats.classes > 1 && (
        <>
          <span className="opacity-40">·</span>
          <span className="opacity-80">{stats.classes} classes</span>
        </>
      )}
      <button
        type="button"
        aria-label="Clear selection"
        title="Clear selection (Escape)"
        onClick={() => clearSelection()}
        className={cn(
          "ml-1 grid h-5 w-5 place-items-center rounded-full",
          "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
          "hover:bg-[var(--bg-hover)]",
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// Armin Mehri — mehri.armin@gmail.com
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
 */
export function SelectionCountBadge() {
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const count = selectedIds.length;
  if (count <= 1) return null;
  return (
    <div
      data-testid="selection-count-badge"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute top-2 left-2 z-20",
        "inline-flex items-center gap-2 px-2.5 h-7 rounded-full",
        "glass-tooltip",
        "text-[11.5px] font-medium tracking-tight tabular-tight",
        "text-[color:var(--text-secondary)]",
      )}
    >
      <span className="text-[color:var(--text-primary)]">{count}</span>
      <span className="opacity-70">selected - Delete to remove</span>
    </div>
  );
}

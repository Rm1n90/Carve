import { Square, Pentagon, Brush, Tag, X } from "lucide-react";
import { useAnnotations } from "@/state/annotations";
import { cn } from "@/lib/cn";

const KIND_ICON = {
  bbox: Square,
  polygon: Pentagon,
  mask: Brush,
  tag: Tag,
} as const;

export function ObjectsPanel({ frameId }: { frameId: string | null }) {
  const byId = useAnnotations((s) => s.byId);
  const selectedId = useAnnotations((s) => s.selectedId);
  const select = useAnnotations((s) => s.select);
  const remove = useAnnotations((s) => s.remove);

  const items = Object.values(byId)
    .filter((a) => a.frameId === frameId)
    .sort((a, b) => a.tempId.localeCompare(b.tempId));

  return (
    <section aria-label="Objects on this frame" className="grid gap-2">
      <header className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-[0.10em] text-tertiary font-medium">
          Objects
        </h3>
        <span className="font-mono-data text-[10px] text-tertiary">{items.length}</span>
      </header>
      {items.length === 0 && (
        <p className="text-tertiary text-[12px] italic">No annotations yet on this frame.</p>
      )}
      <ul className="grid gap-1">
        {items.map((a) => {
          const Icon = (KIND_ICON as Record<string, typeof Square>)[a.kind] ?? Square;
          const isSelected = a.tempId === selectedId;
          return (
            <li
              key={a.tempId}
              onClick={() => select(a.tempId)}
              className={cn(
                "group flex items-center gap-2.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 cursor-pointer transition-colors",
                isSelected
                  ? "bg-[var(--accent-bg)] border-[var(--border-accent)] text-primary"
                  : "bg-transparent border-transparent text-secondary hover:bg-[var(--bg-surface)] hover:text-primary",
              )}
            >
              <span aria-label={`${a.kind} icon`} className="text-tertiary">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 text-[12px] tracking-tight">{a.kind}</span>
              <button
                type="button"
                aria-label={`Delete ${a.kind}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete this ${a.kind}?`)) remove(a.tempId);
                }}
                className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[oklch(0.70_0.20_25_/_0.10)] hover:text-[color:var(--danger)]"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

interface Props {
  classes: ClassRow[];
  /** Called when "+ Add class" is clicked. Optional — when omitted, button is hidden. */
  onAddClass?: () => void;
  /** Called when the edit pencil is clicked on a row. */
  onEditClass?: (cid: string) => void;
  /** Called when the trash icon is clicked on a row. */
  onDeleteClass?: (cid: string) => void;
}

/**
 * Right-panel classes list. Search at top, flat list of class chips with
 * color dots, count badge, and edit/delete on hover. "+ Add class" sticky
 * row at the bottom. Active class has --accent-bg.
 */
export function ClassesPanel({ classes, onAddClass, onEditClass, onDeleteClass }: Props) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const byId = useAnnotations((s) => s.byId);

  const [query, setQuery] = useState("");

  // Counts of annotations per class on this asset, computed from the live store.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of Object.values(byId)) {
      m[a.classId] = (m[a.classId] ?? 0) + 1;
    }
    return m;
  }, [byId]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const n = parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = classes[n - 1];
        if (target) setActiveClassId(target.id);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [classes, setActiveClassId]);

  const filtered = query
    ? classes.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : classes;

  return (
    <section
      role="complementary"
      aria-label="Classes"
      className="h-full flex flex-col bg-[var(--bg-app)]"
    >
      <div className="px-3 pt-3 pb-2 border-b border-[var(--border-subtle)]">
        <div className="relative">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--text-tertiary)] pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search classes..."
            aria-label="Search classes"
            className={cn(
              "w-full h-8 pl-8 pr-2 rounded-[var(--radius-sm)]",
              "bg-[var(--bg-elev)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
              "border border-[var(--border-subtle)] text-[12.5px]",
              "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.16)]",
            )}
          />
        </div>
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <li className="px-3 py-4 text-[12.5px] text-[color:var(--text-tertiary)] italic">
            {classes.length === 0 ? "No classes defined." : "No classes match."}
          </li>
        )}
        {filtered.map((c, i) => {
          const isActive = c.id === activeClassId;
          const count = counts[c.id] ?? 0;
          return (
            <li key={c.id}>
              <div
                className={cn(
                  "group relative flex items-center gap-2.5 px-3 py-1.5 cursor-pointer",
                  isActive
                    ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                )}
                onClick={() => setActiveClassId(c.id)}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r-[2px]"
                  />
                )}
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                  style={{ background: c.color }}
                />
                <span className="flex-1 text-[13px] tracking-tight truncate">{c.name}</span>
                {count > 0 && (
                  <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
                    {count}
                  </span>
                )}
                {i < 9 && !isActive && <Kbd>{i + 1}</Kbd>}
                {/* Hover actions */}
                {(onEditClass || onDeleteClass) && (
                  <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                    {onEditClass && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditClass(c.id);
                        }}
                        aria-label={`Edit class ${c.name}`}
                        className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-app)] hover:text-[color:var(--text-primary)]"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    {onDeleteClass && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete class "${c.name}"?`)) onDeleteClass(c.id);
                        }}
                        aria-label={`Delete class ${c.name}`}
                        className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--danger-bg)] hover:text-[color:var(--danger)]"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {onAddClass && (
        <div className="border-t border-[var(--border-subtle)] p-2">
          <button
            type="button"
            onClick={onAddClass}
            className={cn(
              "w-full inline-flex items-center justify-center gap-1.5 h-8 px-3",
              "rounded-[var(--radius-sm)] border border-dashed border-[var(--border-strong)]",
              "text-[12.5px] text-[color:var(--text-secondary)] tracking-tight",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] hover:border-[var(--accent)]",
              "transition-colors",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            Add class
          </button>
        </div>
      )}
    </section>
  );
}

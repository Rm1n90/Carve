import { useEffect } from "react";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

interface Props {
  classes: ClassRow[];
}

export function ClassesPanel({ classes }: Props) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);

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

  return (
    <section aria-label="Classes" className="grid gap-2">
      <header className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-[0.10em] text-tertiary font-medium">
          Classes
        </h3>
        <span className="font-mono-data text-[10px] text-tertiary">{classes.length}</span>
      </header>
      {classes.length === 0 && (
        <p className="text-tertiary text-[12px] italic">No classes defined.</p>
      )}
      <ul className="grid gap-1">
        {classes.map((c, i) => {
          const isActive = c.id === activeClassId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setActiveClassId(c.id)}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left transition-colors",
                  isActive
                    ? "bg-[var(--accent-bg)] border-[var(--border-accent)] text-primary"
                    : "bg-transparent border-transparent text-secondary hover:bg-[var(--bg-surface)] hover:text-primary",
                )}
              >
                <span
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-[var(--border-strong)]"
                  style={{ background: c.color }}
                />
                <span className="flex-1 text-[12px] tracking-tight truncate">{c.name}</span>
                {i < 9 && <Kbd>{i + 1}</Kbd>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

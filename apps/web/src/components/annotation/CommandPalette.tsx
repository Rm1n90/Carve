// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowRight } from "lucide-react";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

interface Props {
  classes: ClassRow[];
  onSaveNow: () => void;
}

export function CommandPalette({ classes, onSaveNow }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const setActiveClassId = useTool((s) => s.setActiveClassId);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const fromClasses = classes
      .filter((c) => c.name.toLowerCase().includes(q))
      .map((c) => ({
        id: `class-${c.id}`,
        label: `Switch class → ${c.name}`,
        color: c.color,
        run: () => setActiveClassId(c.id),
      }));
    const builtins = [
      { id: "save-now", label: "Save now (Cmd+S)", color: undefined, run: onSaveNow },
    ].filter((b) => b.label.toLowerCase().includes(q));
    return [...builtins, ...fromClasses];
  }, [classes, query, setActiveClassId, onSaveNow]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[900] bg-[oklch(0.06_0.012_240_/_0.55)] backdrop-blur-sm"
          />
          <motion.div
            key="palette"
            role="dialog"
            aria-label="Command palette"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "fixed left-1/2 top-[12vh] z-[901] -translate-x-1/2",
              "w-[min(92vw,560px)]",
              "rounded-[var(--radius-lg)] border border-[var(--border-subtle)]",
              "bg-[var(--glass-bg-strong)] backdrop-blur-2xl",
              "shadow-[var(--shadow-elev-3)]",
              "overflow-hidden",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 border-b border-[var(--border-subtle)]">
              <Search className="h-4 w-4 text-tertiary shrink-0" />
              <input
                autoFocus
                aria-label="command-palette-input"
                placeholder="Type a class name or 'save'…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && items[0]) {
                    items[0].run();
                    setOpen(false);
                    setQuery("");
                  }
                }}
                className="flex-1 h-12 bg-transparent text-primary placeholder:text-tertiary focus:outline-none text-[14px] tracking-tight"
              />
              <Kbd>ESC</Kbd>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto p-1.5">
              {items.slice(0, 50).map((it) => (
                <li
                  key={it.id}
                  onClick={() => {
                    it.run();
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 cursor-pointer text-[13px] text-secondary transition-colors hover:bg-[var(--bg-surface)] hover:text-primary"
                >
                  {it.color ? (
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-[3px] border border-[var(--border-strong)]"
                      style={{ background: it.color }}
                    />
                  ) : (
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                  )}
                  <span className="flex-1">{it.label}</span>
                </li>
              ))}
              {items.length === 0 && (
                <li className="px-3 py-3 text-tertiary text-[13px] italic">No matches.</li>
              )}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";

import type { ClassRow } from "@/api/classes";
import { cn } from "@/lib/cn";

interface ClassCommandPaletteProps {
  open: boolean;
  classes: ClassRow[];
  onClose: () => void;
  onPick: (classId: string) => void;
  /**
   * Optional title shown above the search input. Defaults to "Pick a
   * class". Useful when the palette is repurposed (e.g. "Move to class
   * ...").
   */
  title?: string;
}

/**
 * v3.8 Phase 3.6 -- Class Command Palette.
 *
 * A floating fuzzy-search picker for classes. Solves the "1-9 doesn't
 * scale past 9 classes" problem and gives a single, learnable shortcut
 * (``/`` while a SAM / Polygon / Bbox candidate is active) that works
 * for 5 classes or 500.
 *
 * Keyboard:
 *   /        open (handled by the parent canvas)
 *   type     filter (case-insensitive substring match on name)
 *   ArrowUp/Down navigate
 *   Enter    pick the highlighted class
 *   Esc      close without picking
 *
 * The palette purposely keeps state minimal -- selectedIdx is
 * derived from the filtered list every render so the highlight never
 * drifts onto a hidden row.
 */
export function ClassCommandPalette({
  open,
  classes,
  onClose,
  onPick,
  title = "Pick a class",
}: ClassCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset filter + autofocus on every open so re-opens always start
  // from a clean slate.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      // Defer focus to next tick so Radix-style portal mounting
      // doesn't race the focus call.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return classes;
    return classes.filter((c) => c.name.toLowerCase().includes(q));
  }, [classes, query]);

  // Clamp highlight when the filter shrinks the list below the
  // current index.
  useEffect(() => {
    if (highlight >= filtered.length)
      setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlight]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="class-command-palette"
      className="fixed inset-0 z-[950] grid place-items-start pt-[18vh]"
      onClick={onClose}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[rgba(15,23,42,0.32)] animate-confirm-fade-in"
      />
      <div
        className={cn(
          "relative mx-auto w-[min(92vw,520px)]",
          "rounded-[var(--radius-lg)] glass-surface-strong glass-specular",
          "shadow-[0_24px_60px_rgba(0,0,0,0.45)]",
          "p-3",
          "animate-confirm-in",
        )}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)] px-2 pb-1.5">
          {title}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to filter classes..."
          data-testid="class-command-palette-input"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) =>
                filtered.length === 0
                  ? 0
                  : Math.min(filtered.length - 1, h + 1),
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const c = filtered[highlight];
              if (c) {
                onPick(c.id);
                onClose();
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className={cn(
            "w-full h-9 px-3 mb-2",
            "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-sunken)] text-[13px] text-[color:var(--text-primary)]",
            "placeholder:text-[color:var(--text-tertiary)]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        />
        <ul
          role="listbox"
          aria-label="Class results"
          className="max-h-[40vh] overflow-y-auto grid gap-0.5"
        >
          {filtered.length === 0 && (
            <li className="px-2 py-3 text-[12.5px] italic text-[color:var(--text-tertiary)]">
              No classes match &quot;{query}&quot;.
            </li>
          )}
          {filtered.map((c, i) => {
            const active = i === highlight;
            return (
              <li
                key={c.id}
                role="option"
                aria-selected={active}
                data-testid={`class-command-palette-item-${c.id}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  onPick(c.id);
                  onClose();
                }}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-xs)] cursor-pointer",
                  "transition-colors",
                  active
                    ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--border-strong)]"
                  style={{ background: c.color }}
                  aria-hidden
                />
                <span className="font-mono text-[10px] text-[color:var(--text-tertiary)] w-7 shrink-0">
                  #{c.idx}
                </span>
                <span className="flex-1 text-[13px] truncate">{c.name}</span>
                {c.text_prompt && (
                  <span
                    className="text-[10.5px] italic text-[color:var(--text-tertiary)] truncate max-w-[180px]"
                    title={c.text_prompt}
                  >
                    {c.text_prompt}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

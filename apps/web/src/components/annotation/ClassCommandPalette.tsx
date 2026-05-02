import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Star } from "lucide-react";

import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { useClassRecents } from "@/state/classRecents";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Plan 14 Phase 8 Task 4 — Class Command Palette.
 *
 * A Cmd-K-style searchable picker that scales past the 1-9 number-key
 * limit. Supports two modes:
 *
 *   - ``set-active``  — pick the next active class (open via ``/`` or
 *                       Cmd-Shift-C).
 *   - ``reassign``    — bulk-reassign all selected annotations to the
 *                       picked class (open via ``R`` when at least one
 *                       annotation is selected).
 *
 * Tabs:                Pinned (when ≥1 pinned) · Recent (when ≥1 recent) · All.
 * Default tab:         the first non-empty tab.
 * Score:               name.startsWith(q) > name.includes(q) > filtered out.
 *
 * Keyboard:
 *   ↑ / ↓              navigate
 *   Enter              pick
 *   Tab                cycle through tabs
 *   ⌘P / Ctrl-P        toggle pin on highlighted row
 *   Esc                close
 */
export type PaletteMode = "set-active" | "reassign";

export type PaletteTab = "pinned" | "recent" | "all";

const EMPTY_STR_ARR: string[] = [];

export interface ClassCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: PaletteMode;
  projectId: string;
  classes: ClassRow[];
  /** Populated when ``mode === 'reassign'`` — the ids that will be re-classed on pick. */
  selectedAnnotationIds?: string[];
  /** Optional initial query — used by the canvas type-to-filter flow (Task 5). */
  initialQuery?: string;
}

interface ScoredRow {
  cls: ClassRow;
  /** 0 = startsWith, 1 = includes. Filtered-out rows are dropped before scoring. */
  score: 0 | 1;
}

function scoreClass(cls: ClassRow, q: string): 0 | 1 | -1 {
  if (!q) return 1;
  const name = cls.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  return -1;
}

export function ClassCommandPalette({
  open,
  onOpenChange,
  mode,
  projectId,
  classes,
  selectedAnnotationIds = [],
  initialQuery = "",
}: ClassCommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState(initialQuery);
  const [tab, setTab] = useState<PaletteTab>("all");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Subscribed reads — select the stable map reference and slice with
  // useMemo. Selecting ``map[pid] ?? []`` would return a fresh array
  // on every render and infinite-loop zustand's subscriber.
  const pinnedByProject = useClassRecents((s) => s.pinnedByProject);
  const recentByProject = useClassRecents((s) => s.recentByProject);
  const pinnedIds = useMemo<string[]>(
    () => pinnedByProject[projectId] ?? EMPTY_STR_ARR,
    [pinnedByProject, projectId],
  );
  const recentIds = useMemo<string[]>(
    () => recentByProject[projectId] ?? EMPTY_STR_ARR,
    [recentByProject, projectId],
  );

  // Reset on open. We intentionally re-read ``initialQuery`` so the
  // canvas type-to-filter flow can seed the palette with the first
  // typed letter.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setHighlight(0);
    // Default tab = first non-empty: Pinned > Recent > All.
    const next: PaletteTab =
      pinnedIds.length > 0 ? "pinned" : recentIds.length > 0 ? "recent" : "all";
    setTab(next);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery]);

  const byId = useMemo(() => {
    const m = new Map<string, ClassRow>();
    for (const c of classes) m.set(c.id, c);
    return m;
  }, [classes]);

  // Available tabs in display order.
  const tabs = useMemo<PaletteTab[]>(() => {
    const ts: PaletteTab[] = [];
    if (pinnedIds.length > 0) ts.push("pinned");
    if (recentIds.length > 0) ts.push("recent");
    ts.push("all");
    return ts;
  }, [pinnedIds.length, recentIds.length]);

  // Resolve the active tab's source list.
  const sourceList = useMemo<ClassRow[]>(() => {
    if (tab === "pinned") {
      return pinnedIds
        .map((id) => byId.get(id))
        .filter((c): c is ClassRow => Boolean(c));
    }
    if (tab === "recent") {
      return recentIds
        .map((id) => byId.get(id))
        .filter((c): c is ClassRow => Boolean(c));
    }
    return classes;
  }, [tab, pinnedIds, recentIds, classes, byId]);

  // Filter + score.
  const filtered = useMemo<ScoredRow[]>(() => {
    const q = query.trim().toLowerCase();
    const rows: ScoredRow[] = [];
    for (const c of sourceList) {
      const s = scoreClass(c, q);
      if (s === -1) continue;
      rows.push({ cls: c, score: s });
    }
    if (q) {
      // startsWith before includes; preserve original order within score bucket.
      rows.sort((a, b) => a.score - b.score);
    }
    return rows;
  }, [sourceList, query]);

  // Clamp highlight when the filter shrinks the list below the current index.
  useEffect(() => {
    if (highlight >= filtered.length)
      setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlight]);

  if (!open) return null;

  const headerCopy =
    mode === "set-active"
      ? "Pick active class"
      : `Reassign ${selectedAnnotationIds.length} annotation${selectedAnnotationIds.length === 1 ? "" : "s"} to…`;

  function commitPick(classId: string): void {
    const cls = byId.get(classId);
    if (!cls) return;
    if (mode === "set-active") {
      useTool.getState().setActiveClassId(classId);
    } else {
      for (const id of selectedAnnotationIds) {
        useAnnotations.getState().update(id, { classId });
      }
      const n = selectedAnnotationIds.length;
      showToast(
        `Reassigned ${n} annotation${n === 1 ? "" : "s"} to ${cls.name}`,
        { variant: "success" },
      );
    }
    useClassRecents.getState().recordUse(projectId, classId);
    onOpenChange(false);
  }

  function cycleTab(direction: 1 | -1): void {
    if (tabs.length <= 1) return;
    const i = tabs.indexOf(tab);
    const next = tabs[(i + direction + tabs.length) % tabs.length];
    setTab(next);
    setHighlight(0);
  }

  function togglePinHighlighted(): void {
    const row = filtered[highlight];
    if (!row) return;
    useClassRecents.getState().togglePin(projectId, row.cls.id);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={headerCopy}
      data-testid="class-command-palette"
      data-mode={mode}
      className="fixed inset-0 z-[950] grid place-items-start pt-[18vh]"
      onClick={() => onOpenChange(false)}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[rgba(15,23,42,0.32)] animate-confirm-fade-in"
      />
      <div
        className={cn(
          "relative mx-auto w-[min(92vw,560px)]",
          "rounded-[var(--radius-lg)] glass-surface-strong glass-specular",
          "shadow-[0_24px_60px_rgba(0,0,0,0.45)]",
          "p-3",
          "animate-confirm-in",
        )}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)] px-2 pb-1.5"
          data-testid="class-command-palette-header"
        >
          {headerCopy}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to filter classes…"
          data-testid="class-command-palette-input"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) =>
                filtered.length === 0 ? 0 : Math.min(filtered.length - 1, h + 1),
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = filtered[highlight];
              if (row) commitPick(row.cls.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onOpenChange(false);
            } else if (e.key === "Tab") {
              e.preventDefault();
              cycleTab(e.shiftKey ? -1 : 1);
            } else if (
              (e.metaKey || e.ctrlKey) &&
              e.key.toLowerCase() === "p"
            ) {
              e.preventDefault();
              togglePinHighlighted();
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
        {tabs.length > 1 && (
          <div
            role="tablist"
            data-testid="class-command-palette-tabs"
            className="flex items-center gap-1 px-1 pb-2"
          >
            {tabs.map((t) => {
              const label =
                t === "pinned" ? "Pinned" : t === "recent" ? "Recent" : "All";
              const active = tab === t;
              return (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  data-testid={`class-command-palette-tab-${t}`}
                  onClick={() => {
                    setTab(t);
                    setHighlight(0);
                  }}
                  className={cn(
                    "h-6 px-2.5 rounded-[var(--radius-xs)] text-[11.5px] tracking-tight",
                    active
                      ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                      : "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)]",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <ul
          role="listbox"
          aria-label="Class results"
          className="max-h-[40vh] overflow-y-auto grid gap-0.5"
        >
          {filtered.length === 0 && (
            <li className="px-2 py-3 text-[12.5px] italic text-[color:var(--text-tertiary)]">
              {query
                ? `No classes match "${query}".`
                : tab === "pinned"
                  ? "No pinned classes yet — press ⌘P on a row to pin."
                  : tab === "recent"
                    ? "No recent classes yet."
                    : "No classes."}
            </li>
          )}
          {filtered.map(({ cls }, i) => {
            const active = i === highlight;
            const isPinned = pinnedIds.includes(cls.id);
            // Index hint: position in the *all* list, only shown for the
            // first 9 classes (matches the existing 1..9 hotkey scheme).
            const allIdx = classes.findIndex((c) => c.id === cls.id);
            const hint = allIdx >= 0 && allIdx < 9 ? String(allIdx + 1) : null;
            return (
              <li
                key={cls.id}
                role="option"
                aria-selected={active}
                data-testid={`class-command-palette-item-${cls.id}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commitPick(cls.id)}
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
                  style={{ background: cls.color }}
                  aria-hidden
                />
                <span className="flex-1 text-[13px] truncate">{cls.name}</span>
                {hint && (
                  <span
                    className="font-mono text-[10px] tabular-nums w-5 text-center shrink-0 rounded-[var(--radius-xs)] bg-[var(--bg-sunken)] text-[color:var(--text-tertiary)]"
                    data-testid={`class-command-palette-hint-${cls.id}`}
                  >
                    {hint}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={isPinned ? `Unpin ${cls.name}` : `Pin ${cls.name}`}
                  data-testid={`class-command-palette-pin-${cls.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useClassRecents
                      .getState()
                      .togglePin(projectId, cls.id);
                  }}
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] shrink-0",
                    isPinned
                      ? "text-[color:var(--accent)]"
                      : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                  )}
                >
                  <Star
                    className="h-3 w-3"
                    fill={isPinned ? "currentColor" : "none"}
                  />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] px-1 text-[10.5px] text-[color:var(--text-tertiary)] tracking-tight">
          ↑↓ navigate · Enter pick · ⌘P pin · Esc close
        </div>
      </div>
    </div>
  );
}

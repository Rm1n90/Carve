import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
  Square,
  Pentagon,
  Brush,
  Tag,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowDown01,
  ArrowDown10,
  Check,
  MoreVertical,
  Eraser,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { Kbd } from "@/components/ui/Kbd";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { PALETTE_HEX, nextHexForIdx } from "@/lib/swatch";

interface Props {
  classes: ClassRow[];
  onAddClass?: () => void;
  onEditClass?: (cid: string) => void;
  onDeleteClass?: (cid: string) => void;
  onUpdateColor?: (cid: string, color: string) => void;
  onCreateClass?: (name: string, color: string) => void;
  /**
   * v3.0 B2 — current frame in the editor. Used to scope the "Clear on this
   * frame" per-class action. ``null`` covers single-image assets where every
   * annotation has ``frameId === null``.
   */
  currentFrameId?: string | null;
}

type SortMode = "idx" | "name-asc" | "name-desc" | "count-asc" | "count-desc";

const KIND_ICON = {
  bbox: Square,
  polygon: Pentagon,
  mask: Brush,
  tag: Tag,
} as const;

// v2.9 P2 G1 — shared empty array sentinel so the `?? EMPTY_ARR` fallback
// doesn't allocate a new `[]` every render (and thus break referential
// equality in downstream memoised consumers).
const EMPTY_ARR: { tempId: string; kind: keyof typeof KIND_ICON }[] = [];

// PALETTE is now imported from lib/swatch.ts as PALETTE_HEX so all color
// surfaces share the same deterministic order. See bug F in the v2.1 audit.

function ColorPickerPopover({
  color,
  onChange,
  ariaLabel,
}: {
  color: string;
  onChange?: (c: string) => void;
  ariaLabel: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]",
            "transition-transform hover:scale-110",
          )}
          style={{ background: color }}
          data-testid="class-color-swatch"
        />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="grid grid-cols-6 gap-1 p-2">
        {PALETTE_HEX.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Set color ${c}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange?.(c);
            }}
            className={cn(
              "h-6 w-6 rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
              "hover:scale-110 transition-transform",
            )}
            style={{ background: c }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function AnnotationRow({
  ann,
  classColor,
  hovered,
  selected,
  hidden,
}: {
  ann: { tempId: string; kind: keyof typeof KIND_ICON };
  classColor: string;
  hovered: boolean;
  selected: boolean;
  hidden: boolean;
}) {
  const Icon = KIND_ICON[ann.kind] ?? Square;
  const setHover = useTool((s) => s.setHoveredAnnotationId);
  const select = useAnnotations((s) => s.select);
  const remove = useAnnotations((s) => s.remove);
  const setHiddenAnn = useAnnotations((s) => s.setHiddenForAnnotation);
  const confirm = useConfirm();

  return (
    // v2.9 P1-18 — keyboard parity with mouse-click selection.
    <li
      role="button"
      tabIndex={0}
      data-testid={`annotation-row-${ann.tempId}`}
      data-hovered={hovered ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      onMouseEnter={() => setHover(ann.tempId)}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        select(ann.tempId);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          select(ann.tempId);
        }
      }}
      className={cn(
        "group flex items-center gap-2 pl-7 pr-2 py-1 cursor-pointer",
        "text-[12px] tracking-tight",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
        selected
          ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
          : hovered
            ? "bg-[var(--bg-hover)] text-[color:var(--text-primary)]"
            : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" style={{ color: classColor }} />
      <span className="flex-1 font-mono text-[10.5px] tabular-nums truncate">
        {ann.tempId.slice(0, 7)}
      </span>
      <button
        type="button"
        aria-label={hidden ? "Show annotation" : "Hide annotation"}
        onClick={(e) => {
          e.stopPropagation();
          setHiddenAnn(ann.tempId, !hidden);
        }}
        className="grid h-5 w-5 place-items-center text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
      >
        {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </button>
      <button
        type="button"
        aria-label="Delete annotation"
        onClick={async (e) => {
          // v2.9 P1-11 — confirm before destroying.
          e.stopPropagation();
          const ok = await confirm({
            title: "Delete annotation?",
            description: "Press Cmd+Z to undo, or click Delete to remove.",
            confirmLabel: "Delete",
            variant: "danger",
          });
          if (ok) remove(ann.tempId);
        }}
        className="grid h-5 w-5 place-items-center text-[color:var(--text-tertiary)] hover:text-[color:var(--danger)] opacity-0 group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  );
}

function ClassRowItem({
  cls,
  index,
  count,
  isActive,
  expanded,
  onToggleExpand,
  hidden,
  onToggleHidden,
  onEditClass,
  onDeleteClass,
  onClearOnFrame,
  frameAnnotationCount,
  onUpdateColor,
  classAnnotations,
  hoveredAnnId,
  selectedAnnIds,
  hiddenAnnIds,
}: {
  cls: ClassRow;
  index: number;
  count: number;
  isActive: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  hidden: boolean;
  onToggleHidden: () => void;
  onEditClass?: (cid: string) => void;
  onDeleteClass?: (cid: string) => void;
  /**
   * v3.0 B2 — invoked from the row's 3-dot menu. Removes every annotation of
   * this class on the current frame after a count-aware confirm dialog.
   */
  onClearOnFrame?: (cid: string, count: number) => void;
  /** Count of this class's annotations on the current frame (drives the menu copy). */
  frameAnnotationCount: number;
  onUpdateColor?: (cid: string, color: string) => void;
  classAnnotations: { tempId: string; kind: keyof typeof KIND_ICON }[];
  hoveredAnnId: string | null;
  selectedAnnIds: string[];
  hiddenAnnIds: string[];
}) {
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const confirm = useConfirm();
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (
      hoveredAnnId &&
      classAnnotations.some((a) => a.tempId === hoveredAnnId) &&
      typeof rowRef.current?.scrollIntoView === "function"
    ) {
      rowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [hoveredAnnId, classAnnotations]);

  return (
    <li ref={rowRef} data-testid={`class-row-${cls.id}`}>
      {/* v2.9 P1-18 — class header was a <div> with onClick; expose it
          as a button to AT and route Enter/Space to setActiveClassId. */}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "group relative flex items-center gap-2 px-2.5 py-2 h-9 cursor-pointer",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
          isActive
            ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
            : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]",
        )}
        onClick={() => setActiveClassId(cls.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActiveClassId(cls.id);
          }
        }}
        data-active={isActive ? "true" : undefined}
      >
        {isActive && (
          <span
            aria-hidden
            className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r-[2px]"
          />
        )}
        <button
          type="button"
          aria-label={expanded ? "Collapse class annotations" : "Expand class annotations"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          data-testid={`class-expand-${cls.id}`}
          className="grid h-4 w-4 place-items-center text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <ColorPickerPopover
          color={cls.color}
          ariaLabel={`Edit color of ${cls.name}`}
          onChange={(c) => onUpdateColor?.(cls.id, c)}
        />
        <span className="flex-1 text-[13px] tracking-tight truncate flex items-baseline gap-1">
          {cls.name}
          {count > 0 && (
            <sup
              className="font-mono text-[9.5px] text-[color:var(--text-tertiary)] tabular-nums"
              data-testid={`class-count-${cls.id}`}
            >
              {count}
            </sup>
          )}
        </span>
        {index < 9 && !isActive && <Kbd>{index + 1}</Kbd>}
        <span
          className={cn(
            "flex items-center gap-0.5",
            isActive ? "" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden();
            }}
            aria-label={hidden ? `Show class ${cls.name}` : `Hide class ${cls.name}`}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)]",
              "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-app)] hover:text-[color:var(--text-primary)]",
            )}
          >
            {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
          {onEditClass && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditClass(cls.id);
              }}
              aria-label={`Edit class ${cls.name}`}
              className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-app)] hover:text-[color:var(--text-primary)]"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {(onDeleteClass || onClearOnFrame) && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`More actions for class ${cls.name}`}
                  data-testid={`class-menu-trigger-${cls.id}`}
                  className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-app)] hover:text-[color:var(--text-primary)]"
                >
                  <MoreVertical className="h-3 w-3" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  onClick={(e) => e.stopPropagation()}
                  className="z-[1000] min-w-[200px] rounded-[var(--radius-md)] glass-surface-strong p-1"
                >
                  {onClearOnFrame && (
                    <DropdownMenu.Item
                      data-testid={`class-menu-clear-frame-${cls.id}`}
                      disabled={frameAnnotationCount === 0}
                      onSelect={() => {
                        if (frameAnnotationCount > 0) {
                          onClearOnFrame(cls.id, frameAnnotationCount);
                        }
                      }}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] outline-none",
                        "data-[highlighted]:bg-[var(--bg-hover)]",
                        "data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
                        frameAnnotationCount > 0
                          ? "cursor-pointer text-[color:var(--text-primary)]"
                          : "text-[color:var(--text-tertiary)]",
                      )}
                    >
                      <Eraser className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
                      <span className="flex-1">Clear on this frame</span>
                      {frameAnnotationCount > 0 && (
                        <span className="font-mono text-[10.5px] tabular-nums text-[color:var(--text-tertiary)]">
                          {frameAnnotationCount}
                        </span>
                      )}
                    </DropdownMenu.Item>
                  )}
                  {onDeleteClass && (
                    <DropdownMenu.Item
                      data-testid={`class-menu-delete-${cls.id}`}
                      onSelect={async () => {
                        const ok = await confirm({
                          title: "Delete class?",
                          description: (
                            <>
                              Remove the class{" "}
                              <span className="font-medium text-[color:var(--text-primary)]">
                                {cls.name}
                              </span>
                              ? Annotations referencing it will become unclassified.
                            </>
                          ),
                          variant: "danger",
                          confirmLabel: "Delete",
                        });
                        if (ok) onDeleteClass(cls.id);
                      }}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none",
                        "text-[color:var(--danger)]",
                        "data-[highlighted]:bg-[var(--danger-bg)]",
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="flex-1">Delete class…</span>
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </span>
      </div>
      {expanded && classAnnotations.length > 0 && (
        <ul className="pb-1" data-testid={`class-annotations-${cls.id}`}>
          {classAnnotations.map((a) => (
            <AnnotationRow
              key={a.tempId}
              ann={a}
              classColor={cls.color}
              hovered={hoveredAnnId === a.tempId}
              selected={selectedAnnIds.includes(a.tempId)}
              hidden={hiddenAnnIds.includes(a.tempId)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddClassInline({
  onCreate,
  onCancel,
  currentClassCount,
}: {
  onCreate: (name: string, color: string) => void;
  onCancel: () => void;
  /** Used to seed the next-up palette slot so successive adds get distinct colors. */
  currentClassCount: number;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(() => nextHexForIdx(currentClassCount));
  // Defensive wrapper: if the parent's `onCreate` throws synchronously
  // (programming error, mid-flight teardown, etc.), the React event
  // dispatcher would rethrow into the global error handler and could
  // unmount the surrounding panel. Wrapping here keeps the inline form
  // alive and lets the user retry — same intent as the try/catch around
  // `mutateAsync` in ClassesEditor.tsx.
  function safeCreate(n: string, c: string) {
    try {
      onCreate(n, c);
    } catch {
      /* parent surfaces the error via its mutation state; we just
         keep the inline form mounted so the panel doesn't disappear. */
    }
  }
  return (
    <div
      data-testid="add-class-inline"
      className={cn(
        "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-app)] p-2 grid gap-2",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <ColorPickerPopover
          color={color}
          ariaLabel="New class color"
          onChange={(c) => setColor(c)}
        />
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Class name"
          aria-label="New class name"
          className={cn(
            "flex-1 h-7 px-2 text-[12.5px]",
            "bg-transparent text-[color:var(--text-primary)]",
            "rounded-[var(--radius-sm)] border border-[var(--glass-border)]",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              safeCreate(name.trim(), color);
              setName("");
            } else if (e.key === "Escape") {
              onCancel();
            }
          }}
        />
      </div>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2.5 rounded-[var(--radius-sm)] text-[12px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => name.trim() && safeCreate(name.trim(), color)}
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[12px] font-medium",
            "bg-[var(--accent)] text-[color:var(--accent-fg)]",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
            "enabled:hover:bg-[var(--accent-hover)]",
          )}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Right-panel classes list with search, sort, color-picker, expandable
 * annotation rows, eye-toggle visibility, and sticky add-class footer.
 * Hovering an annotation row sets `hoveredAnnotationId`; the canvas listens
 * to the same store and brightens the matching shape.
 */
export function ClassesPanel({
  classes,
  onAddClass,
  onEditClass,
  onDeleteClass,
  onUpdateColor,
  onCreateClass,
  currentFrameId = null,
}: Props) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const hoveredAnnotationId = useTool((s) => s.hoveredAnnotationId);
  const byId = useAnnotations((s) => s.byId);
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const hiddenClassIds = useAnnotations((s) => s.hiddenClassIds);
  const hiddenAnnotationIds = useAnnotations((s) => s.hiddenAnnotationIds);
  const setHiddenForClass = useAnnotations((s) => s.setHiddenForClass);
  const confirm = useConfirm();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("idx");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of Object.values(byId)) {
      m[a.classId] = (m[a.classId] ?? 0) + 1;
    }
    return m;
  }, [byId]);

  // v3.0 B2 — per-class count of annotations on the *current frame*. Drives
  // the "Clear on this frame" menu item: copy/disabled state + confirm copy.
  const frameCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of Object.values(byId)) {
      if (a.frameId === currentFrameId) {
        m[a.classId] = (m[a.classId] ?? 0) + 1;
      }
    }
    return m;
  }, [byId, currentFrameId]);

  const handleClearOnFrame = async (classId: string, n: number) => {
    if (n === 0) return;
    const cls = classes.find((c) => c.id === classId);
    const name = cls?.name ?? "this class";
    const ok = await confirm({
      title: "Clear annotations on this frame?",
      description: (
        <>
          Delete <span className="font-medium text-[color:var(--text-primary)]">{n}</span>{" "}
          annotation{n === 1 ? "" : "s"} of class{" "}
          <span className="font-medium text-[color:var(--text-primary)]">{name}</span> on
          this frame? Press Cmd+Z to undo.
        </>
      ),
      variant: "danger",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    const store = useAnnotations.getState();
    const targets = Object.values(store.byId).filter(
      (a) => a.frameId === currentFrameId && a.classId === classId,
    );
    for (const t of targets) {
      useAnnotations.getState().remove(t.tempId);
    }
  };

  const annotationsByClass = useMemo(() => {
    const m: Record<string, { tempId: string; kind: keyof typeof KIND_ICON }[]> = {};
    for (const a of Object.values(byId)) {
      const list = m[a.classId] ?? [];
      list.push({ tempId: a.tempId, kind: a.kind as keyof typeof KIND_ICON });
      m[a.classId] = list;
    }
    return m;
  }, [byId]);

  useEffect(() => {
    if (!hoveredAnnotationId) return;
    const ann = byId[hoveredAnnotationId];
    if (!ann) return;
    setExpanded((prev) => (prev[ann.classId] ? prev : { ...prev, [ann.classId]: true }));
  }, [hoveredAnnotationId, byId]);

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

  const filtered = useMemo(() => {
    let out = query
      ? classes.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      : [...classes];
    if (sort === "name-asc") {
      out.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "name-desc") {
      out.sort((a, b) => b.name.localeCompare(a.name));
    } else if (sort === "count-asc") {
      out.sort((a, b) => (counts[a.id] ?? 0) - (counts[b.id] ?? 0));
    } else if (sort === "count-desc") {
      out.sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));
    } else {
      out.sort((a, b) => a.idx - b.idx);
    }
    return out;
  }, [classes, query, sort, counts]);

  const sortLabel: Record<SortMode, { icon: typeof ArrowDownAZ; label: string }> = {
    idx: { icon: ArrowDownAZ, label: "Default" },
    "name-asc": { icon: ArrowDownAZ, label: "Name A → Z" },
    "name-desc": { icon: ArrowDownZA, label: "Name Z → A" },
    "count-asc": { icon: ArrowDown01, label: "Count low → high" },
    "count-desc": { icon: ArrowDown10, label: "Count high → low" },
  };

  return (
    <section
      role="complementary"
      aria-label="Classes"
      className="h-full flex flex-col bg-transparent"
    >
      <div className="px-2.5 pt-3 pb-2 border-b border-[var(--glass-border)] grid gap-2">
        <h3
          aria-hidden
          className="font-editorial text-[18px] leading-none text-[color:var(--text-primary)] px-0.5"
        >
          Classes
        </h3>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search
              aria-hidden
              className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--text-tertiary)] pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search classes…"
              aria-label="Search classes"
              data-testid="classes-search-input"
              className={cn(
                "w-full h-8 pl-8 pr-2 rounded-[var(--radius-sm)]",
                "glass-surface-subtle text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
                "text-[12.5px]",
                "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.16)]",
              )}
            />
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Sort classes"
                data-testid="classes-sort-trigger"
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]",
                  "glass-chip text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]",
                )}
              >
                {(() => {
                  const Icon = sortLabel[sort].icon;
                  return <Icon className="h-3.5 w-3.5" />;
                })()}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-[1000] min-w-[180px] rounded-[var(--radius-md)] glass-surface-strong p-1"
              >
                {(["idx", "name-asc", "name-desc", "count-asc", "count-desc"] as SortMode[]).map(
                  (key) => {
                    const { icon: Icon, label } = sortLabel[key];
                    return (
                      <DropdownMenu.Item
                        key={key}
                        onSelect={() => setSort(key)}
                        data-testid={`sort-${key}`}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] cursor-pointer outline-none hover:bg-[var(--bg-hover)] data-[highlighted]:bg-[var(--bg-hover)]"
                      >
                        <Icon className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
                        <span className="flex-1">{label}</span>
                        {sort === key && <Check className="h-3 w-3 text-[color:var(--accent)]" />}
                      </DropdownMenu.Item>
                    );
                  },
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <li className="px-3 py-4 text-[12.5px] text-[color:var(--text-tertiary)] italic">
            {classes.length === 0 ? "No classes defined." : "No classes match."}
          </li>
        )}
        {filtered.map((c, i) => {
          const cAnns = annotationsByClass[c.id] ?? EMPTY_ARR;
          return (
            <ClassRowItem
              key={c.id}
              cls={c}
              index={i}
              count={counts[c.id] ?? 0}
              isActive={c.id === activeClassId}
              expanded={!!expanded[c.id]}
              onToggleExpand={() =>
                setExpanded((prev) => ({ ...prev, [c.id]: !prev[c.id] }))
              }
              hidden={hiddenClassIds.includes(c.id)}
              onToggleHidden={() => setHiddenForClass(c.id, !hiddenClassIds.includes(c.id))}
              onEditClass={onEditClass}
              onDeleteClass={onDeleteClass}
              onClearOnFrame={handleClearOnFrame}
              frameAnnotationCount={frameCounts[c.id] ?? 0}
              onUpdateColor={onUpdateColor}
              classAnnotations={cAnns}
              hoveredAnnId={hoveredAnnotationId}
              selectedAnnIds={selectedIds}
              hiddenAnnIds={hiddenAnnotationIds}
            />
          );
        })}
      </ul>

      <div className="border-t border-[var(--border-subtle)] p-2">
        {showAdd && onCreateClass ? (
          <AddClassInline
            currentClassCount={classes.length}
            onCreate={(n, c) => {
              onCreateClass(n, c);
              setShowAdd(false);
            }}
            onCancel={() => setShowAdd(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (onCreateClass) {
                setShowAdd(true);
              } else if (onAddClass) {
                onAddClass();
              }
            }}
            data-testid="classes-add-button"
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
        )}
      </div>
    </section>
  );
}

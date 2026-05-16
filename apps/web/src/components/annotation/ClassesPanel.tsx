// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keybindingsApi } from "@/api/keybindings";
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
  Star,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import type { ClassRow } from "@/api/classes";
import { useTool } from "@/state/tool";
import { useAnnotations } from "@/state/annotations";
import { useClassRecents } from "@/state/classRecents";
import { ClassCommandPalette } from "@/components/annotation/ClassCommandPalette";
import { showToast } from "@/lib/toast";
import { Kbd } from "@/components/ui/Kbd";
import { Input } from "@/components/ui/Input";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { PALETTE_HEX, nextHexForIdx } from "@/lib/swatch";
import { ClassificationStrip } from "./ClassificationStrip";

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
  /** Merged digit → classId map (see lib/class-keybindings). Used for
   *  both badge rendering and the digit keyboard handler. */
  digitToClassId?: Record<number, string>;
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
const EMPTY_STR_ARR: string[] = [];

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
      <PopoverContent align="start" sideOffset={4} className="grid gap-2 p-2">
        {/* v3.2 Issue 6 — preset swatches + native custom-color picker share
            the same onChange path. Selecting a non-palette hex from the native
            picker simply forwards through; the swatch grid stays unselected. */}
        <div className="grid grid-cols-6 gap-1">
          {PALETTE_HEX.map((c) => {
            const isSelected = c.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                aria-label={`Set color ${c}`}
                data-selected={isSelected ? "true" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange?.(c);
                }}
                className={cn(
                  "h-6 w-6 rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
                  "hover:scale-110 transition-transform",
                  isSelected && "ring-2 ring-[var(--accent)] ring-offset-1",
                )}
                style={{ background: c }}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
          <span className="text-[11px] tracking-tight text-[color:var(--text-tertiary)]">
            Custom
          </span>
          <input
            type="color"
            aria-label="Custom color"
            data-testid="class-color-custom"
            value={color}
            onChange={(e) => {
              e.stopPropagation();
              onChange?.(e.target.value);
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-6 w-10 cursor-pointer rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-transparent p-0"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Custom MIME used by AnnotationRow → ClassRowItem drag-and-drop. Sticks
// to a unique vendor-prefixed type so the browser doesn't try to
// interpret the payload as a URL / file / arbitrary text in any other
// drop target.
const ANN_DRAG_MIME = "application/x-carve-annotations";
const ANN_DRAG_SEP = ",";

// One-time hint for class digit shortcuts, shown on first mount when
// digitToClassId is non-empty.
const HINT_KEY = "carve.class-keybindings.hint-seen-v1";

function parseAnnDragIds(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const raw = dt.getData(ANN_DRAG_MIME);
  if (!raw) return [];
  return raw.split(ANN_DRAG_SEP).filter((s) => s.length > 0);
}

function AnnotationRow({
  ann,
  classColor,
  hovered,
  selected,
  hidden,
  selectedIds,
  onRequestReassign,
}: {
  ann: { tempId: string; kind: keyof typeof KIND_ICON };
  classColor: string;
  hovered: boolean;
  selected: boolean;
  hidden: boolean;
  /** Live multi-selection from the store — used to broaden the drag /
   *  right-click target set when the user grabs a selected row. */
  selectedIds: string[];
  /** Called on contextmenu/right-click with the ids to reassign (the
   *  full selection when this row is part of it, otherwise just this
   *  row). The panel opens the class-picker palette in response. */
  onRequestReassign: (ids: string[]) => void;
}) {
  const Icon = KIND_ICON[ann.kind] ?? Square;
  const setHover = useTool((s) => s.setHoveredAnnotationId);
  const select = useAnnotations((s) => s.select);
  const toggleSelect = useAnnotations((s) => s.toggleSelect);
  const remove = useAnnotations((s) => s.remove);
  const setHiddenAnn = useAnnotations((s) => s.setHiddenForAnnotation);
  // v3.27.11 — Shift/Cmd/Ctrl-click extend the selection (toggle in/out
  // of the selectedIds set) just like the canvas pointerdown handler
  // does. Plain click still replaces the selection. Without this, the
  // expansion list was a single-select-only surface — users couldn't
  // build a multi-selection from the right rail.
  const handleSelect = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelect(ann.tempId);
    else select(ann.tempId);
  };

  // When the user grabs (drag / right-click) a row that's part of the
  // current multi-selection, target ALL selected ids; otherwise just
  // this row. Mirrors what the canvas context-menu does for parity.
  const resolveTargetIds = (): string[] => {
    if (selected && selectedIds.length > 1) return [...selectedIds];
    return [ann.tempId];
  };

  return (
    // v2.9 P1-18 — keyboard parity with mouse-click selection.
    <li
      role="button"
      tabIndex={0}
      data-testid={`annotation-row-${ann.tempId}`}
      data-hovered={hovered ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      draggable
      onMouseEnter={() => setHover(ann.tempId)}
      onMouseLeave={() => setHover(null)}
      onContextMenu={(e) => {
        // Right-click → open the class-picker palette in reassign mode.
        // preventDefault stops the browser's native menu from racing
        // our UI; stopPropagation keeps the canvas listener silent.
        e.preventDefault();
        e.stopPropagation();
        const ids = resolveTargetIds();
        // Make sure the row is at least visually selected when the
        // user right-clicks an unselected row — the palette will reuse
        // these ids verbatim.
        if (!selected && ids.length === 1) select(ids[0]);
        onRequestReassign(ids);
      }}
      onDragStart={(e) => {
        const ids = resolveTargetIds();
        // Vendor MIME so other drop targets don't accidentally accept
        // our payload. Plain-text fallback also set so debugging tools
        // can see the dragged ids.
        e.dataTransfer.setData(ANN_DRAG_MIME, ids.join(ANN_DRAG_SEP));
        e.dataTransfer.setData("text/plain", ids.join(ANN_DRAG_SEP));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        e.stopPropagation();
        handleSelect(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          handleSelect(e);
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
        title="Delete annotation (Cmd+Z to undo)"
        onClick={(e) => {
          // v3.27.9 — single-click delete (no confirm dialog).
          // Cmd+Z still restores the annotation; the original
          // confirm step was friction the user explicitly asked
          // to remove.
          e.stopPropagation();
          remove(ann.tempId);
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
  isPinned,
  onTogglePin,
  onRequestReassign,
  onDropAnnotations,
  digitBadge,
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
  isPinned: boolean;
  onTogglePin: () => void;
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
  /** Right-click on a contained AnnotationRow bubbles up via this. */
  onRequestReassign: (ids: string[]) => void;
  /** Fired when a drop lands on this class — `ids` is the tempIds
   *  carried by the drag, `targetClassId` is this row's id. The panel
   *  calls setActiveClassForSelected(targetClassId, ids). */
  onDropAnnotations: (targetClassId: string, ids: string[]) => void;
  /** Digit shortcut bound to this class via class-keybindings. ``undefined``
   *  means no binding; overrides the legacy positional badge. */
  digitBadge?: number;
}) {
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const confirm = useConfirm();
  const rowRef = useRef<HTMLLIElement>(null);
  const [isHover, setIsHover] = useState(false);
  // Drop-target highlight state. Tracked locally rather than via a
  // store so it's contained to this row — bulk class lists don't pay
  // for re-renders elsewhere on a drag hover.
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    if (
      hoveredAnnId &&
      classAnnotations.some((a) => a.tempId === hoveredAnnId) &&
      typeof rowRef.current?.scrollIntoView === "function"
    ) {
      rowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [hoveredAnnId, classAnnotations]);

  // v3.32 — tint the row with the class's own color. Opacity ramps
  // with state so the row feels alive without drowning the content:
  //   default → 10%   (clearly identifiable, text fully legible)
  //   hover   → 18%   (signals interactivity)
  //   active  → 28%   (matches the dot, plus the left accent stripe)
  // ``color-mix`` blends against ``transparent`` so the underlying
  // panel surface still shows through for theme parity.
  const tintPct = isActive ? 28 : isHover ? 18 : 10;
  const rowTint = `color-mix(in oklch, ${cls.color} ${tintPct}%, transparent)`;

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
          "transition-colors duration-150",
          isActive
            ? "text-[color:var(--text-primary)]"
            : "text-[color:var(--text-secondary)]",
          isDropTarget &&
            "ring-2 ring-inset ring-[var(--accent)] ring-offset-0",
        )}
        style={{ backgroundColor: rowTint }}
        onMouseEnter={() => setIsHover(true)}
        onMouseLeave={() => setIsHover(false)}
        onClick={() => setActiveClassId(cls.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActiveClassId(cls.id);
          }
        }}
        // HTML5 drag-and-drop: accept annotation rows dropped from
        // any class. dragover must preventDefault to declare this an
        // active drop target (the browser's default is to reject).
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(ANN_DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!isDropTarget) setIsDropTarget(true);
        }}
        onDragLeave={() => {
          if (isDropTarget) setIsDropTarget(false);
        }}
        onDrop={(e) => {
          setIsDropTarget(false);
          const ids = parseAnnDragIds(e.dataTransfer);
          if (ids.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          onDropAnnotations(cls.id, ids);
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
        {digitBadge !== undefined && (
          <Kbd
            data-testid={`class-row-kbd-${cls.id}`}
            aria-label={`Digit shortcut ${digitBadge}`}
          >
            {digitBadge}
          </Kbd>
        )}
        <span
          className={cn(
            "flex items-center gap-0.5",
            // Pin star is always visible (when pinned) so users can find
            // their pinned set at a glance; the rest of the action group
            // still hides on hover.
            isActive ? "" : isPinned ? "" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            aria-label={isPinned ? `Unpin class ${cls.name}` : `Pin class ${cls.name}`}
            data-testid={`class-pin-${cls.id}`}
            data-pinned={isPinned ? "true" : undefined}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-[var(--radius-sm)]",
              isPinned
                ? "text-[color:var(--accent)] hover:bg-[var(--bg-app)]"
                : "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-app)] hover:text-[color:var(--text-primary)]",
            )}
          >
            <Star className="h-3 w-3" fill={isPinned ? "currentColor" : "none"} />
          </button>
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
                  // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
                  className={cn(
                    "z-[1000] min-w-[200px] rounded-[var(--radius-6)] p-1",
                    "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                    "shadow-[var(--shadow-card)]",
                  )}
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
                        const annotationsForThisClass = count;
                        const ok = await confirm({
                          title: "Delete class?",
                          description: (
                            <>
                              Remove the class{" "}
                              <span className="font-medium text-[color:var(--text-primary)]">
                                {cls.name}
                              </span>
                              ?
                              {annotationsForThisClass > 0 && (
                                <>
                                  {" "}This will also{" "}
                                  <span className="font-medium text-[color:var(--danger)]">
                                    permanently delete {annotationsForThisClass}{" "}
                                    annotation
                                    {annotationsForThisClass === 1 ? "" : "s"}
                                  </span>{" "}
                                  that use it.
                                </>
                              )}{" "}
                              The remaining classes will be renumbered so their
                              order stays contiguous. This action is irreversible.
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
      {expanded && (
        <>
          {/* v3.30 — inline SAM-prompt editor removed. Auto-Annotate
              and Smart Find dialogs now own per-class prompt editing
              with the Smart Find class+prompt rows pattern. */}
          {classAnnotations.length > 0 && (
            <ul className="pb-1" data-testid={`class-annotations-${cls.id}`}>
              {classAnnotations.map((a) => (
                <AnnotationRow
                  key={a.tempId}
                  ann={a}
                  classColor={cls.color}
                  hovered={hoveredAnnId === a.tempId}
                  selected={selectedAnnIds.includes(a.tempId)}
                  hidden={hiddenAnnIds.includes(a.tempId)}
                  selectedIds={selectedAnnIds}
                  onRequestReassign={onRequestReassign}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

// v3.30 — ClassPromptInline removed. Inline class+prompt editing
// now lives in the Auto-Annotate / Smart Find dialogs.

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
          className="h-7 px-2.5 rounded-[var(--radius-6)] text-[12px] text-[color:var(--text-secondary)] transition-colors duration-[180ms] ease-out hover:bg-[var(--bg-hover)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => name.trim() && safeCreate(name.trim(), color)}
          className={cn(
            // DESIGN.md §4 — primary CTA carries the full PS hover
            // signature.
            "h-7 px-2.5 rounded-[var(--radius-pill)] text-[12px] font-medium",
            "bg-[var(--accent)] text-[color:var(--accent-fg)]",
            "border border-[var(--accent)]",
            "transition-all duration-[180ms] ease-out",
            "enabled:hover:bg-[var(--accent-hover)] enabled:hover:border-white",
            "enabled:hover:shadow-[0_0_0_2px_var(--accent)] enabled:hover:scale-[1.05]",
            "active:opacity-60 active:scale-100",
            "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)] disabled:cursor-not-allowed",
            "disabled:border-[var(--border-subtle)]",
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
  digitToClassId,
}: Props) {
  const activeClassId = useTool((s) => s.activeClassId);
  const setActiveClassId = useTool((s) => s.setActiveClassId);
  const hoveredAnnotationId = useTool((s) => s.hoveredAnnotationId);
  // Plan-18 follow-up — only surface the Classify chip strip when the
  // user is in the Tag tool (T). Avoids cluttering the panel during
  // bbox/polygon/mask work; the T shortcut is the natural way in/out.
  const activeTool = useTool((s) => s.active);
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
  // Reassign palette state. Holds the tempIds to re-class while the
  // palette is open; null when closed. Driven by right-click on an
  // AnnotationRow — see handleRequestReassign below.
  const [reassignIds, setReassignIds] = useState<string[] | null>(null);

  const handleRequestReassign = (ids: string[]) => {
    if (ids.length === 0) return;
    setReassignIds(ids);
  };

  const handleDropAnnotations = (
    targetClassId: string,
    ids: string[],
  ) => {
    if (ids.length === 0) return;
    // Drop on the SAME class is a no-op — but we toast briefly so the
    // user doesn't think the drop "failed silently". The store's
    // setActiveClassForSelected already skips no-op drafts at the
    // entry level (no history churn), so calling it unconditionally
    // is safe; we just need user feedback when nothing changed.
    const cur = useAnnotations.getState().byId;
    const willChange = ids.some(
      (id) => cur[id] && cur[id].classId !== targetClassId,
    );
    if (!willChange) return;
    useAnnotations.getState().setActiveClassForSelected(targetClassId, ids);
    const className =
      classes.find((c) => c.id === targetClassId)?.name ?? "class";
    showToast(
      `Reassigned ${ids.length} annotation${ids.length === 1 ? "" : "s"} to ${className}.`,
      { variant: "success", duration: 1800 },
    );
  };
  // Plan 14 Phase 8 Task 4 — when ``classes.length > 12`` collapse the
  // v3.29 — removed the "Show all (N)" expander. Large-project users
  // (≥50 classes) found the disclosure a speed bump; the outer panel
  // is already scroll-bounded so always rendering every class doesn't
  // cost layout space.

  // Project id is derived from the first class — every class on a
  // project shares the same project_id, and the panel never mounts
  // without at least one class once a project has been opened.
  const projectId = classes[0]?.project_id ?? "";
  // Important: select the *map* (stable reference) and read the slot
  // inline with useMemo. Selecting ``map[pid] ?? []`` would return a
  // new ``[]`` on every render and infinite-loop zustand's subscriber.
  const pinnedByProject = useClassRecents((s) => s.pinnedByProject);
  const pinnedIds = useMemo<string[]>(
    () => (projectId ? (pinnedByProject[projectId] ?? EMPTY_STR_ARR) : EMPTY_STR_ARR),
    [pinnedByProject, projectId],
  );
  const togglePin = useClassRecents((s) => s.togglePin);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of Object.values(byId)) {
      m[a.classId] = (m[a.classId] ?? 0) + 1;
    }
    return m;
  }, [byId]);

  // Inverted map: classId → digit. Used to render the [N] badge on each
  // class row and to detect same-digit toggle (unbind) on Shift+digit.
  const digitByClassId = useMemo(() => {
    const r: Record<string, number> = {};
    if (digitToClassId) {
      for (const [d, id] of Object.entries(digitToClassId)) {
        r[id] = parseInt(d, 10);
      }
    }
    return r;
  }, [digitToClassId]);

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
    const ids = Object.values(store.byId)
      .filter(
        (a) => a.frameId === currentFrameId && a.classId === classId,
      )
      .map((a) => a.tempId);
    // v3.24.14 — single bulk delete instead of N synchronous remove()
    // calls. Avoids the "last shape lingers for ~1s" re-render cascade
    // when clearing a heavily-populated class.
    if (ids.length > 0) useAnnotations.getState().removeMany(ids);
  };

  // v3.27.7 — class-row expansion now lists only the annotations whose
  // frameId matches the active frame so the user sees a "what's drawn on
  // THIS frame" view instead of a flat dump of every polygon across the
  // whole video. For image assets there's only one frame_id (the asset's
  // primary frame), so this is a no-op — filtering keeps every entry.
  const annotationsByClass = useMemo(() => {
    const m: Record<string, { tempId: string; kind: keyof typeof KIND_ICON }[]> = {};
    for (const a of Object.values(byId)) {
      if (currentFrameId != null && a.frameId !== currentFrameId) continue;
      const list = m[a.classId] ?? [];
      list.push({ tempId: a.tempId, kind: a.kind as keyof typeof KIND_ICON });
      m[a.classId] = list;
    }
    return m;
  }, [byId, currentFrameId]);

  useEffect(() => {
    if (!hoveredAnnotationId) return;
    const ann = byId[hoveredAnnotationId];
    if (!ann) return;
    setExpanded((prev) => (prev[ann.classId] ? prev : { ...prev, [ann.classId]: true }));
  }, [hoveredAnnotationId, byId]);

  // One-time hint: show a discoverability tip after keybindings data first resolves.
  useEffect(() => {
    if (!digitToClassId) return;
    if (Object.keys(digitToClassId).length === 0) return; // nothing to hint about
    try {
      if (window.localStorage.getItem(HINT_KEY) === "1") return;
      showToast(
        "Tip: select a class and press Shift+digit to assign that key.",
        { variant: "info", duration: 6000 },
      );
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* localStorage disabled — silently skip */
    }
  }, [digitToClassId]);

  const qc = useQueryClient();
  const putBinding = useMutation({
    mutationFn: ({ digit, classId }: { digit: number; classId: string }) =>
      keybindingsApi.put(projectId, digit, classId),
    onSettled: () => qc.invalidateQueries({
      queryKey: ["class-keybindings", projectId],
    }),
  });
  const clearBinding = useMutation({
    mutationFn: (digit: number) => keybindingsApi.remove(projectId, digit),
    onSettled: () => qc.invalidateQueries({
      queryKey: ["class-keybindings", projectId],
    }),
  });

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const digit = parseInt(e.key, 10);

      // Shift+digit → bind / unbind.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const activeId = useTool.getState().activeClassId;
        if (!activeId) {
          showToast("Select a class first to bind a hotkey.", {
            variant: "info", duration: 3000,
          });
          return;
        }
        e.preventDefault();
        const current = digitToClassId?.[digit];
        if (current === activeId) {
          clearBinding.mutate(digit);
          showToast(`Digit ${digit} cleared`, { variant: "info" });
        } else {
          const activeClass = classes.find((c) => c.id === activeId);
          putBinding.mutate({ digit, classId: activeId });
          showToast(
            `Digit ${digit} → ${activeClass?.name ?? "class"}`,
            { variant: "success" },
          );
        }
        return;
      }

      // Any other modifier → not our chord.
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

      // Plain digit → activate the bound class.
      const targetId = digitToClassId?.[digit];
      if (targetId) {
        e.preventDefault();
        setActiveClassId(targetId);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    digitToClassId, classes, setActiveClassId, projectId,
    putBinding, clearBinding,
  ]);

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
          <div className="flex-1">
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search classes…"
              aria-label="Search classes"
              data-testid="classes-search-input"
              leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
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
                // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
                className={cn(
                  "z-[1000] min-w-[180px] rounded-[var(--radius-6)] p-1",
                  "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                  "shadow-[var(--shadow-card)]",
                )}
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

      {activeTool === "tag" && (
        <ClassificationStrip classes={classes} frameId={currentFrameId ?? null} />
      )}

      <ul
        className="flex-1 min-h-0 overflow-y-auto py-1"
        data-testid="classes-panel-list"
      >
        {filtered.length === 0 && (
          <li className="px-3 py-4 text-[12.5px] text-[color:var(--text-tertiary)] italic">
            {classes.length === 0 ? "No classes defined." : "No classes match."}
          </li>
        )}
        {(() => {
          // Plan 14 Phase 8 Task 4 — Pinned group + collapsible "All
          // classes (N)" when the project has > 12 classes. Search /
          // sort affect the All group only; pinned ordering matches the
          // pin-history (most recently pinned at the bottom). When the
          // user is searching, we skip the grouping and render the
          // filtered hits flat — the user is clearly drilling into a
          // specific match.
          const isSearching = query.trim().length > 0;
          const renderRow = (c: ClassRow, i: number) => {
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
                onToggleHidden={() =>
                  setHiddenForClass(c.id, !hiddenClassIds.includes(c.id))
                }
                onEditClass={onEditClass}
                onDeleteClass={onDeleteClass}
                onClearOnFrame={handleClearOnFrame}
                frameAnnotationCount={frameCounts[c.id] ?? 0}
                onUpdateColor={onUpdateColor}
                classAnnotations={cAnns}
                hoveredAnnId={hoveredAnnotationId}
                selectedAnnIds={selectedIds}
                hiddenAnnIds={hiddenAnnotationIds}
                isPinned={pinnedIds.includes(c.id)}
                onTogglePin={() =>
                  projectId && togglePin(projectId, c.id)
                }
                onRequestReassign={handleRequestReassign}
                onDropAnnotations={handleDropAnnotations}
                digitBadge={digitByClassId[c.id]}
              />
            );
          };

          if (isSearching) {
            return filtered.map((c, i) => renderRow(c, i));
          }

          const pinnedSet = new Set(pinnedIds);
          const pinned = pinnedIds
            .map((id) => filtered.find((c) => c.id === id))
            .filter((c): c is ClassRow => Boolean(c));
          const rest = filtered.filter((c) => !pinnedSet.has(c.id));
          return (
            <>
              {pinned.length > 0 && (
                <li
                  className="px-2.5 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--text-tertiary)]"
                  data-testid="classes-pinned-header"
                >
                  Pinned
                </li>
              )}
              {pinned.map((c, i) => renderRow(c, i))}
              {pinned.length > 0 && rest.length > 0 && (
                <li
                  className="mx-2.5 my-1 border-t border-[var(--border-subtle)]"
                  aria-hidden
                />
              )}
              {/* Always render all remaining classes — the outer panel
                  is already scroll-bounded, and hiding classes behind a
                  "Show all" disclosure made large-project workflows
                  (≥50 classes) slow. */}
              {rest.map((c, i) => renderRow(c, i))}
            </>
          );
        })()}
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
      {/* Right-click → reassign palette. Reuses the canvas-side
          ClassCommandPalette so the search / pinned / recent UX is
          consistent across both surfaces. ``selectedAnnotationIds``
          drives the bulk-reassign; ``setActiveClassForSelected`` is
          called from inside the palette on pick. */}
      {projectId && (
        <ClassCommandPalette
          open={reassignIds !== null}
          onOpenChange={(o) => {
            if (!o) setReassignIds(null);
          }}
          mode="reassign"
          projectId={projectId}
          classes={classes}
          selectedAnnotationIds={reassignIds ?? []}
        />
      )}
    </section>
  );
}

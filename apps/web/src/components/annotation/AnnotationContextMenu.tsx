// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  ChevronsDown,
  Trash2,
  Minus,
  Tag as TagIcon,
  ChevronRight,
  Copy,
  Clipboard as ClipboardIcon,
  CopyPlus,
  Lock,
  Unlock,
  Maximize2,
  ZoomIn,
  Eye,
} from "lucide-react";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { applyVertexDelete, POLY_MIN_VERTICES } from "@/canvas/polygonEdit";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { setContextMenuOpen } from "@/state/contextMenuState";
import { buildPolygon } from "@/lib/geometryConvert";
import { samPolygonForGeometry } from "@/lib/samConvert";
import { bulkConvertSelectedToBboxWithToast } from "@/lib/bulkConvert";
import { localizeHotkey } from "@/lib/platform";
import { formatChord } from "@/lib/shortcuts/chord";
import { useShortcut } from "@/state/shortcuts";
import type { ClassRow } from "@/api/classes";

// v3.20 -- the hotkey labels rendered next to menu items are now
// driven by the user's customizable shortcuts. The legacy
// ``localizeHotkey`` helper is kept around for any non-customizable
// labels (none today; reserved for future static hotkeys).
void localizeHotkey;

/**
 * Returns the live, formatted hotkey labels for every customizable
 * action this menu surfaces. Pulls each chord through ``useShortcut``
 * so overrides (and resets) are reflected immediately.
 */
function useMenuHotkeys() {
  return {
    front: formatChord(useShortcut("bring_to_front")),
    up: formatChord(useShortcut("bring_forward")),
    down: formatChord(useShortcut("send_backward")),
    back: formatChord(useShortcut("send_to_back")),
    paste: formatChord(useShortcut("paste")),
    duplicate: formatChord(useShortcut("duplicate")),
    copy: formatChord(useShortcut("copy")),
  };
}

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  hotkey?: string;
  onSelect: (annId: string) => void;
}

function buildZItems(hk: ReturnType<typeof useMenuHotkeys>): MenuItem[] {
  return [
    {
      key: "front",
      label: "Bring to Front",
      icon: <ChevronsUp className="h-3.5 w-3.5" />,
      hotkey: hk.front,
      onSelect: (id) => useAnnotations.getState().bringToFront(id),
    },
    {
      key: "forward",
      label: "Bring Forward",
      icon: <ChevronUp className="h-3.5 w-3.5" />,
      hotkey: hk.up,
      onSelect: (id) => useAnnotations.getState().bringForward(id),
    },
    {
      key: "backward",
      label: "Send Backward",
      icon: <ChevronDown className="h-3.5 w-3.5" />,
      hotkey: hk.down,
      onSelect: (id) => useAnnotations.getState().sendBackward(id),
    },
    {
      key: "back",
      label: "Send to Back",
      icon: <ChevronsDown className="h-3.5 w-3.5" />,
      hotkey: hk.back,
      onSelect: (id) => useAnnotations.getState().sendToBack(id),
    },
  ];
}

interface Props {
  hostRef: React.RefObject<HTMLElement | null>;
  hitTest: (clientX: number, clientY: number) => string | null;
  vertexHitTest?: (
    clientX: number,
    clientY: number,
  ) => { annId: string; vertexIndex: number } | null;
  classes?: ClassRow[];
  toImageXY?: (clientX: number, clientY: number) => { x: number; y: number };
  frameId?: string | null;
  imageBounds?: { w: number; h: number };
  /**
   * Plan-17 — current asset id, used by the "Convert ▸" submenu so SAM
   * roundtrips know which image to operate on. Optional because the
   * menu also handles non-asset contexts (e.g. tag annotations).
   */
  assetId?: string;
}

type MenuState =
  | {
      kind: "annotation";
      x: number;
      y: number;
      annId: string;
      vertexIndex?: number;
    }
  | {
      kind: "empty";
      x: number;
      y: number;
      imageX: number;
      imageY: number;
    };

const VIEWPORT_MARGIN = 8;
const SUBMENU_WIDTH = 200;

function MenuButton({
  testId,
  icon,
  label,
  hotkey,
  disabled,
  danger,
  onClick,
}: {
  testId: string;
  icon: ReactNode;
  label: string;
  hotkey?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      // Plan-17 — stop pointerdown / mousedown at the button level
      // (capture-phase) so the native event never reaches the canvas
      // host. Belt-and-braces for the menu wrapper isolation.
      onPointerDownCapture={(e) => e.stopPropagation()}
      onMouseDownCapture={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        // eslint-disable-next-line no-console
        console.log("[MenuButton]", testId, "clicked");
        onClick();
      }}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left",
        danger
          ? "text-[color:var(--danger)] hover:bg-[var(--danger-bg)]"
          : "hover:bg-[var(--bg-hover)]",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
    >
      <span className="text-[color:var(--text-tertiary)]">{icon}</span>
      <span className="flex-1">{label}</span>
      {hotkey && <Kbd>{hotkey}</Kbd>}
    </button>
  );
}

/**
 * Plan 15 Phase 9 — refined right-click context menu.
 *
 * - Hover-triggered "Pick class" submenu (no extra click required).
 * - Custom Change-color removed; class color is the source of truth.
 * - Position is clamped to the viewport so menus near edges stay usable.
 */
interface ConvertItemsProps {
  annId: string;
  assetId: string;
  frameId?: string | null;
  geometry: import("@/state/annotations").Geometry;
  imageBounds?: { w: number; h: number };
  onAfterAction: () => void;
}

/**
 * Plan-17 — flat inline Convert items. Earlier hover-submenu version
 * shipped, but submenu positioning near the viewport edge made the
 * items unreachable in some layouts. Flat inline buttons avoid the
 * hover/timing/positioning class of bugs entirely; the items are
 * pruned by the source geometry kind so the menu stays small.
 *
 *   - polygon / mask_rle: "→ BBox" (instant), "Refine with SAM"
 *   - bbox             : "→ Polygon (SAM)"
 */
function ConvertItems({
  annId,
  assetId,
  frameId,
  geometry,
  imageBounds,
  onAfterAction,
}: ConvertItemsProps) {
  const [pending, setPending] = useState(false);
  // Plan-19 — realtime progress for bulk SAM convert/refine. Updated
  // each iteration of the loop so the disabled button can render
  // "Refining 3/10…" instead of a static spinner the user has no way
  // to interpret.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const isPolygonal = geometry.kind === "polygon" || geometry.kind === "mask_rle";
  const isBbox = geometry.kind === "bbox";
  // Plan-19 / Item 2 — surface the multi-target count in button labels.
  // Whenever a multi-selection exists, prefer it: even if the user
  // right-clicked an annotation that's NOT part of the selection, we
  // keep the existing selection (the parent's onContextMenu guard does
  // the same) so the bulk action behaves consistently with what the
  // user sees highlighted in the canvas.
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const targetCount = selectedIds.length > 1 ? selectedIds.length : 1;
  const countSuffix = targetCount > 1 ? ` (${targetCount})` : "";

  // Plan-17 / Item 2 — bulk-aware ids. Whenever a multi-selection
  // exists, return it (even if the right-clicked id isn't part of
  // it) so right-click on a non-selected annotation never silently
  // collapses the user's selection back to a single target.
  function bulkIds(): string[] {
    const sel = useAnnotations.getState().selectedIds;
    if (sel.length > 1) {
      // eslint-disable-next-line no-console
      console.log("[Convert] bulk on", sel.length, "selected");
      return sel;
    }
    return [annId];
  }

  function commitToBbox() {
    bulkConvertSelectedToBboxWithToast(bulkIds());
    onAfterAction();
  }

  async function refineOrPolygonize(label: string) {
    if (pending) return;
    setPending(true);
    const ids = bulkIds();
    setProgress({ done: 0, total: ids.length });
    let succeeded = 0;
    let failed = 0;
    let lastErr: unknown = null;
    // Plan-17 — defensive: clear any in-progress canvas drag state so a
    // stale dragRef from a click-into-the-menu sequence cannot
    // overwrite the converted geometry on a subsequent pointermove.
    window.dispatchEvent(new CustomEvent("carve:cancel-drag"));
    try {
      for (const id of ids) {
        const cur = useAnnotations.getState().byId[id];
        if (!cur) {
          // eslint-disable-next-line no-console
          console.warn("[Convert] no draft for id", id);
          failed++;
          continue;
        }
        try {
          const points = await samPolygonForGeometry({
            assetId,
            frameId,
            geometry: cur.geometry,
          });
          if (!points) {
            // eslint-disable-next-line no-console
            console.warn("[Convert] SAM returned no polygon for", id);
            failed++;
            continue;
          }
          const clamped = imageBounds
            ? points.map(
                ([x, y]) =>
                  [
                    Math.max(0, Math.min(imageBounds.w, x)),
                    Math.max(0, Math.min(imageBounds.h, y)),
                  ] as [number, number],
              )
            : points;
          const poly = buildPolygon(clamped);
          if (!poly) {
            // eslint-disable-next-line no-console
            console.warn(
              "[Convert] SAM polygon was degenerate after clamp",
              id,
              points.length,
            );
            failed++;
            continue;
          }
          useAnnotations.getState().update(id, {
            geometry: poly,
            kind: "polygon",
            dirty: true,
          });
          // eslint-disable-next-line no-console
          console.log("[Convert] succeeded", id, "vertices=", poly.points.length);
          succeeded++;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[Convert] error for id", id, err);
          lastErr = err;
          failed++;
        }
        setProgress((prev) =>
          prev ? { done: prev.done + 1, total: prev.total } : prev,
        );
      }
      if (succeeded > 0) {
        showToast(
          `${label}: ${succeeded} ${succeeded === 1 ? "annotation" : "annotations"}${failed > 0 ? `, ${failed} failed` : ""}.`,
          { variant: "success" },
        );
      } else {
        const detail =
          (lastErr as { response?: { data?: { detail?: string } } })?.response
            ?.data?.detail ||
          (lastErr as { message?: string })?.message ||
          "no polygon returned";
        showToast(
          `${label} failed for all ${failed} annotations — ${detail}.`,
          { variant: "error", duration: 5000 },
        );
      }
      onAfterAction();
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ||
        (err as { message?: string })?.message ||
        "SAM request failed.";
      showToast(`${label} failed — ${detail}`, {
        variant: "error",
        duration: 5000,
      });
    } finally {
      setPending(false);
      setProgress(null);
    }
  }

  // Plan-17 — these match the MenuButton click pathway exactly
  // (button-level onPointerDownCapture + onMouseDownCapture stopPropagation,
  // explicit "[MenuButton] <id> clicked" log) so they never silently
  // drop a click. The earlier raw-button form was missing the capture
  // handlers and clicks weren't reaching React for some users on some
  // annotations.
  const stopCapture = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      {isPolygonal && (
        <>
          <button
            type="button"
            data-testid="ctx-convert-to-bbox"
            onPointerDownCapture={stopCapture}
            onMouseDownCapture={stopCapture}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // eslint-disable-next-line no-console
              console.log("[MenuButton] ctx-convert-to-bbox clicked");
              commitToBbox();
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)]"
          >
            <Maximize2 className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Convert → BBox{countSuffix}</span>
            <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">
              instant
            </span>
          </button>
          <button
            type="button"
            data-testid="ctx-refine-with-sam"
            disabled={pending}
            onPointerDownCapture={stopCapture}
            onMouseDownCapture={stopCapture}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // eslint-disable-next-line no-console
              console.log("[MenuButton] ctx-refine-with-sam clicked");
              void refineOrPolygonize("Refine with SAM");
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            <ZoomIn className="h-3.5 w-3.5 text-[color:var(--accent)]" />
            <span className="flex-1">
              {pending
                ? progress
                  ? `Refining ${progress.done}/${progress.total}…`
                  : "Refining with SAM…"
                : `Refine with SAM${countSuffix}`}
            </span>
            <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">
              SAM
            </span>
          </button>
        </>
      )}
      {isBbox && (
        <button
          type="button"
          data-testid="ctx-convert-to-polygon"
          disabled={pending}
          onPointerDownCapture={stopCapture}
          onMouseDownCapture={stopCapture}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // eslint-disable-next-line no-console
            console.log("[MenuButton] ctx-convert-to-polygon clicked");
            void refineOrPolygonize("Convert to polygon");
          }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          <ZoomIn className="h-3.5 w-3.5 text-[color:var(--accent)]" />
          <span className="flex-1">
            {pending
              ? progress
                ? `Converting ${progress.done}/${progress.total}…`
                : "Converting with SAM…"
              : `Convert → Polygon (SAM)${countSuffix}`}
          </span>
          <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">
            SAM
          </span>
        </button>
      )}
      {progress && progress.total > 1 && (
        <div
          data-testid="ctx-convert-progress"
          className="mx-2 my-1.5 h-1 rounded-full bg-[var(--bg-sunken)] overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={`Bulk convert progress: ${progress.done} of ${progress.total}`}
        >
          <div
            className="h-full bg-[var(--accent)] transition-[width] duration-150"
            style={{
              width: `${(progress.done / progress.total) * 100}%`,
            }}
          />
        </div>
      )}
    </>
  );
}

export function AnnotationContextMenu({
  hostRef,
  hitTest,
  vertexHitTest,
  classes,
  toImageXY,
  frameId = null,
  imageBounds,
  assetId,
}: Props) {
  const [state, setState] = useState<MenuState | null>(null);
  const [classMenuOpen, setClassMenuOpen] = useState(false);
  const [submenuLeft, setSubmenuLeft] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  // v3.20 -- live hotkey labels and Z-order menu items, reactive to
  // user shortcut overrides. ``HK`` shadows the legacy module-level
  // const that was removed in this change; the call sites below are
  // unchanged.
  const HK = useMenuHotkeys();
  const Z_ITEMS = useMemo(() => buildZItems(HK), [HK]);
  const hoverCloseTimer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function close() {
    setState(null);
    setClassMenuOpen(false);
    setPos(null);
    if (hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function onContextMenu(e: Event) {
      const me = e as MouseEvent;
      // Plan-20.11 / v3.27.9 — when the user is in the Smart (SAM)
      // tool's POINT or TRACK mode, right-click is reserved as a
      // *negative* point prompt. The SAM tool handles the click
      // itself; suppressing the menu here keeps the canvas clean
      // instead of flashing both the negative-point overlay AND the
      // context menu.
      const toolState = useTool.getState();
      if (
        toolState.active === "sam"
        && (toolState.samMode === "point" || toolState.samMode === "track")
      ) {
        me.preventDefault();
        return;
      }
      const vh = vertexHitTest?.(me.clientX, me.clientY);
      if (vh) {
        me.preventDefault();
        useAnnotations.getState().select(vh.annId);
        setState({
          kind: "annotation",
          x: me.clientX,
          y: me.clientY,
          annId: vh.annId,
          vertexIndex: vh.vertexIndex,
        });
        return;
      }
      const annId = hitTest(me.clientX, me.clientY);
      if (annId) {
        me.preventDefault();
        // Plan-19 / Item 2 — preserve an existing multi-selection
        // regardless of whether the right-clicked annotation is part of
        // it. Earlier behaviour collapsed the selection back to a
        // single id on out-of-selection right-click, which silently
        // degraded "select 5 → right-click → Convert" to converting
        // one. The right-clicked id still drives the per-annotation
        // context (geometry kind etc.); ConvertItems.bulkIds() then
        // returns the full selection when sel.length > 1.
        const sel = useAnnotations.getState().selectedIds;
        const hasMultiSelection = sel.length > 1;
        if (!me.shiftKey && !hasMultiSelection) {
          useAnnotations.getState().select(annId);
        }
        setState({
          kind: "annotation",
          x: me.clientX,
          y: me.clientY,
          annId,
        });
        return;
      }
      me.preventDefault();
      const img = toImageXY?.(me.clientX, me.clientY) ?? {
        x: me.clientX,
        y: me.clientY,
      };
      setState({
        kind: "empty",
        x: me.clientX,
        y: me.clientY,
        imageX: img.x,
        imageY: img.y,
      });
    }
    host.addEventListener("contextmenu", onContextMenu);
    return () => host.removeEventListener("contextmenu", onContextMenu);
  }, [hostRef, hitTest, vertexHitTest, toImageXY]);

  useEffect(() => {
    if (!state) {
      setContextMenuOpen(false);
      return;
    }
    // Plan-17 — publish the open state to the shared flag so the
    // AnnotationCanvas pointerdown handler can suppress SAM
    // positive/negative-point clicks both while the menu is open and
    // for a brief window after dismiss (so the click that closes the
    // menu does not also fire SAM behaviour underneath).
    setContextMenuOpen(true);
    function dismiss(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", esc);
      setContextMenuOpen(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useLayoutEffect(() => {
    if (!state) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = state.x;
    let y = state.y;
    if (x + rect.width + VIEWPORT_MARGIN > vw) {
      x = Math.max(VIEWPORT_MARGIN, vw - rect.width - VIEWPORT_MARGIN);
    }
    if (y + rect.height + VIEWPORT_MARGIN > vh) {
      y = Math.max(VIEWPORT_MARGIN, vh - rect.height - VIEWPORT_MARGIN);
    }
    setPos({ x, y });
    setSubmenuLeft(x + rect.width + SUBMENU_WIDTH + VIEWPORT_MARGIN <= vw);
  }, [state]);

  if (!state) return null;
  const top = pos?.y ?? state.y;
  const left = pos?.x ?? state.x;
  const menuStyle: React.CSSProperties = {
    top,
    left,
    visibility: pos ? "visible" : "hidden",
  };

  if (state.kind === "empty") {
    const clipboard = useAnnotations.getState().clipboard;
    const canPaste = clipboard !== null;
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label="Canvas context menu"
        data-testid="canvas-context-menu"
        // Plan-17 — stop pointerdown / contextmenu from bubbling to the
        // canvas host. Without this, clicking a menu item ALSO fires
        // the canvas's pointerdown handler, which in SAM Point mode
        // happily turns it into a positive-point click at the menu
        // button's coordinates. Mouse events fall under the same
        // bubble path so we belt-and-braces both.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        className={cn(
          // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
          "fixed z-[1100] min-w-[220px]",
          "rounded-[var(--radius-6)] p-1",
          "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
          "shadow-[var(--shadow-card)]",
        )}
        style={menuStyle}
      >
        <MenuButton
          testId="ctx-paste"
          icon={<ClipboardIcon className="h-3.5 w-3.5" />}
          label="Paste annotation"
          hotkey={HK.paste}
          disabled={!canPaste}
          onClick={() => {
            useAnnotations
              .getState()
              .pasteFromClipboard(
                state.imageX,
                state.imageY,
                frameId,
                imageBounds,
              );
            close();
          }}
        />
        <div className="my-1 h-px bg-[var(--border-subtle)]" />
        <MenuButton
          testId="ctx-deselect-all"
          icon={<Minus className="h-3.5 w-3.5" />}
          label="Deselect all"
          hotkey="Esc"
          onClick={() => {
            useAnnotations.getState().clearSelection();
            close();
          }}
        />
        <MenuButton
          testId="ctx-fit"
          icon={<Maximize2 className="h-3.5 w-3.5" />}
          label="Fit to screen"
          hotkey="F"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
            close();
          }}
        />
        <MenuButton
          testId="ctx-reset-zoom"
          icon={<ZoomIn className="h-3.5 w-3.5" />}
          label="Reset zoom"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("carve:zoom-to", { detail: { pct: 100 } }),
            );
            close();
          }}
        />
      </div>
    );
  }

  const annId = state.annId;
  const draft = useAnnotations.getState().byId[annId];
  const isLocked = useAnnotations.getState().isLocked(annId);

  function openClassSubmenu() {
    if (hoverCloseTimer.current) {
      window.clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setClassMenuOpen(true);
  }
  function scheduleSubmenuClose() {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = window.setTimeout(() => {
      setClassMenuOpen(false);
      hoverCloseTimer.current = null;
    }, 120);
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Annotation context menu"
      data-testid="annotation-context-menu"
      // Plan-17 — see "empty" branch above. Stops menu clicks from
      // bubbling to the canvas pointerdown listener (which would
      // otherwise turn a left-click on a menu item into a positive
      // SAM-point click in Point mode, etc.).
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className={cn(
        // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
        "fixed z-[1100] min-w-[220px]",
        "rounded-[var(--radius-6)] p-1",
        "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
        "shadow-[var(--shadow-card)]",
      )}
      style={menuStyle}
    >
      <MenuButton
        testId="ctx-change-class-palette"
        icon={<TagIcon className="h-3.5 w-3.5" />}
        label="Change class…"
        hotkey="R"
        onClick={() => {
          useAnnotations.getState().select(annId);
          window.dispatchEvent(
            new CustomEvent("carve:open-class-palette", {
              detail: { mode: "reassign" },
            }),
          );
          close();
        }}
      />

      {classes && classes.length > 0 && (
        <div
          className="relative"
          onMouseEnter={openClassSubmenu}
          onMouseLeave={scheduleSubmenuClose}
        >
          <button
            type="button"
            data-testid="ctx-change-class"
            onFocus={openClassSubmenu}
            aria-haspopup="menu"
            aria-expanded={classMenuOpen}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)]"
          >
            <TagIcon className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            <span className="flex-1">Pick class</span>
            <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
          </button>
          {classMenuOpen && (
            <div
              ref={submenuRef}
              role="menu"
              aria-label="Change class submenu"
              data-testid="ctx-change-class-submenu"
              onMouseEnter={openClassSubmenu}
              onMouseLeave={scheduleSubmenuClose}
              className={cn(
                // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
                "absolute top-0 min-w-[180px] max-h-[260px] overflow-y-auto",
                submenuLeft ? "left-full ml-1" : "right-full mr-1",
                "rounded-[var(--radius-6)] p-1",
                "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                "shadow-[var(--shadow-card)]",
              )}
            >
              {classes.map((c) => {
                const active = draft?.classId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`ctx-change-class-${c.id}`}
                    onClick={() => {
                      if (!active) {
                        useAnnotations
                          .getState()
                          .update(annId, { classId: c.id });
                      }
                      close();
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12px] text-left cursor-pointer",
                      active
                        ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
                        : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                      style={{ background: c.color }}
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="my-1 h-px bg-[var(--border-subtle)]" />

      <MenuButton
        testId="ctx-lock"
        icon={
          isLocked /* keep current branch unchanged */ ? (
            <Unlock className="h-3.5 w-3.5" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )
        }
        label={isLocked ? "Unlock" : "Lock"}
        hotkey="L"
        onClick={() => {
          useAnnotations.getState().toggleLock(annId);
          showToast(isLocked ? "Annotation unlocked." : "Annotation locked.", {
            variant: "success",
          });
          close();
        }}
      />

      <div className="my-1 h-px bg-[var(--border-subtle)]" />

      {Z_ITEMS.map((it) => (
        <MenuButton
          key={it.key}
          testId={`ctx-${it.key}`}
          icon={it.icon}
          label={it.label}
          hotkey={it.hotkey}
          onClick={() => {
            it.onSelect(annId);
            close();
          }}
        />
      ))}

      <div className="my-1 h-px bg-[var(--border-subtle)]" />

      <MenuButton
        testId="ctx-duplicate"
        icon={<CopyPlus className="h-3.5 w-3.5" />}
        label="Duplicate"
        hotkey={HK.duplicate}
        onClick={() => {
          useAnnotations.getState().duplicate(annId, 16, 16, imageBounds);
          showToast("Duplicated annotation.", { variant: "success" });
          close();
        }}
      />
      <MenuButton
        testId="ctx-copy"
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Copy"
        hotkey={HK.copy}
        onClick={() => {
          useAnnotations.getState().copyToClipboard(annId);
          showToast("Copied annotation.", { variant: "success" });
          close();
        }}
      />
      <MenuButton
        testId="ctx-paste-here"
        icon={<ClipboardIcon className="h-3.5 w-3.5" />}
        label="Paste annotation"
        hotkey={HK.paste}
        disabled={useAnnotations.getState().clipboard === null}
        onClick={() => {
          const img = toImageXY?.(state.x, state.y);
          const x = img?.x ?? 0;
          const y = img?.y ?? 0;
          useAnnotations
            .getState()
            .pasteFromClipboard(x, y, frameId, imageBounds);
          close();
        }}
      />

      {/* Plan-17 — flat inline Convert items. Only mounted when we know
          which asset we are operating on (SAM needs ``assetId``) and the
          annotation has spatial extent (tags have nothing to convert). */}
      {assetId && draft && draft.kind !== "tag" && (
        <>
          <div className="my-1 h-px bg-[var(--border-subtle)]" />
          <ConvertItems
            annId={annId}
            assetId={assetId}
            frameId={frameId}
            geometry={draft.geometry}
            imageBounds={imageBounds}
            onAfterAction={close}
          />
        </>
      )}

      <div className="my-1 h-px bg-[var(--border-subtle)]" />

      <MenuButton
        testId="ctx-reveal"
        icon={<Eye className="h-3.5 w-3.5" />}
        label="Reveal in panel"
        onClick={() => {
          useAnnotations.getState().select(annId);
          // Defer the DOM scroll so the panel can re-render with the new
          // selection before we try to find its row. Without this the
          // querySelector frequently misses the row on first invocation
          // because the Objects panel hasn't repainted yet — which is
          // exactly the "Reveal not working" symptom.
          requestAnimationFrame(() => {
            const row = document.querySelector<HTMLElement>(
              `[data-testid="object-row-${annId}"]`,
            );
            if (row) {
              row.scrollIntoView({ behavior: "smooth", block: "nearest" });
              row.classList.add("ring-2", "ring-[color:var(--accent)]");
              setTimeout(() => {
                row.classList.remove("ring-2", "ring-[color:var(--accent)]");
              }, 1500);
            } else {
              showToast("Selected — scroll the right panel to find it.", {
                variant: "success",
              });
            }
          });
          close();
        }}
      />

      {state.vertexIndex !== undefined && (() => {
        const cur = useAnnotations.getState().byId[annId];
        const canDelete =
          cur &&
          cur.geometry.kind === "polygon" &&
          cur.geometry.points.length > POLY_MIN_VERTICES;
        return (
          <>
            <div className="my-1 h-px bg-[var(--border-subtle)]" />
            <MenuButton
              testId="ctx-delete-vertex"
              icon={<Minus className="h-3.5 w-3.5" />}
              label="Delete vertex"
              disabled={!canDelete}
              onClick={() => {
                if (!canDelete) return;
                const c = useAnnotations.getState().byId[annId];
                if (c && c.geometry.kind === "polygon") {
                  const next = applyVertexDelete(
                    c.geometry,
                    state.vertexIndex!,
                  );
                  useAnnotations
                    .getState()
                    .update(annId, { geometry: next });
                }
                close();
              }}
            />
          </>
        );
      })()}

      <div className="my-1 h-px bg-[var(--border-subtle)]" />
      <MenuButton
        testId="ctx-delete"
        icon={<Trash2 className="h-3.5 w-3.5" />}
        label="Delete"
        hotkey="⌫"
        danger
        onClick={() => {
          useAnnotations.getState().remove(annId);
          close();
        }}
      />
    </div>
  );
}

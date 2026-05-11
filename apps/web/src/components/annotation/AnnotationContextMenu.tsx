// Armin Mehri — mehri.armin@gmail.com
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  const menuRef = useRef<HTMLDivElement>(null);

  // v3.20 -- live hotkey labels and Z-order menu items, reactive to
  // user shortcut overrides. ``HK`` shadows the legacy module-level
  // const that was removed in this change; the call sites below are
  // unchanged.
  const HK = useMenuHotkeys();
  const Z_ITEMS = useMemo(() => buildZItems(HK), [HK]);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function close() {
    setState(null);
    setPos(null);
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

  // v3.29 — attach a native wheel listener on the menu so wheel events
  // fired anywhere inside it (including the inline class list's scroll
  // area) don't bubble up to the canvas host listener, which would
  // otherwise zoom the image while the user scrolls through classes.
  // React's synthetic ``onWheel`` only stops React-tree propagation; it
  // does not stop the native bubble path the canvas listener uses.
  useEffect(() => {
    if (!state) return;
    const el = menuRef.current;
    if (!el) return;
    function blockWheel(e: WheelEvent) {
      e.stopPropagation();
    }
    el.addEventListener("wheel", blockWheel, { passive: true });
    return () => el.removeEventListener("wheel", blockWheel);
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
  }, [state]);

  if (!state) return null;
  const top = pos?.y ?? state.y;
  const left = pos?.x ?? state.x;
  const menuStyle: React.CSSProperties = {
    top,
    left,
    // v3.29 — use opacity/pointer-events instead of `visibility` so the
    // input inside InlineClassSearch can receive focus during the
    // first measurement render. `visibility: hidden` blocks `.focus()`
    // at the browser level, which left the menu unfocused on open and
    // sent the user's first keystroke to whichever global shortcut
    // happened to match it.
    opacity: pos ? 1 : 0,
    pointerEvents: pos ? "auto" : "none",
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
      // v3.29 — stop wheel events from bubbling to the canvas while the
      // menu (or its class-pick submenu) is open. Otherwise scrolling a
      // long class list also triggers the canvas's zoom-on-wheel.
      onWheel={(e) => e.stopPropagation()}
      className={cn(
        // DESIGN.md §1 / §6 — solid surface, compact 6px radius.
        "fixed z-[1100] min-w-[220px]",
        "rounded-[var(--radius-6)] p-1",
        "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
        "shadow-[var(--shadow-card)]",
      )}
      style={menuStyle}
    >
      {/* v3.29 — inline class search at the very top of the menu.
          Auto-focused on open so the user can immediately type to
          filter classes without hovering into a submenu. The full class
          palette (R) remains available below for power users. */}
      {classes && classes.length > 0 && (
        <InlineClassSearch
          classes={classes}
          activeClassId={draft?.classId ?? null}
          onPick={(classId) => {
            if (draft?.classId !== classId) {
              useAnnotations.getState().update(annId, { classId });
            }
            close();
          }}
        />
      )}
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

/**
 * v3.29 — inline class search at the top of the right-click context
 * menu. Auto-focused on mount so the user can immediately type to
 * filter classes without hovering into a submenu. ↑/↓ navigate,
 * Enter selects.
 *
 * Replaces the previous "Pick class ▶" submenu — typing in a submenu
 * was a two-step gesture (hover, then type) that broke at scale.
 */
interface InlineClassSearchProps {
  classes: { id: string; name: string; color: string; idx?: number }[];
  activeClassId: string | null;
  onPick: (classId: string) => void;
}

function InlineClassSearch(props: InlineClassSearchProps) {
  const { classes, activeClassId, onPick } = props;
    const [query, setQuery] = useState("");
    const [highlightIdx, setHighlightIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return classes;
      return classes.filter((c) => c.name.toLowerCase().includes(q));
    }, [classes, query]);

    // Reset / keep the highlighted row in bounds whenever the filter changes.
    useEffect(() => {
      setHighlightIdx((prev) => {
        if (filtered.length === 0) return 0;
        if (prev >= filtered.length) return 0;
        return prev;
      });
    }, [filtered.length]);

    // Auto-focus the search input the moment the menu mounts. We try
    // synchronously AND on the next animation frame so we cover the
    // case where the menu's parent measure-then-position effect causes
    // a transient blur, or where the first focus() call lands while
    // the menu is still in its measurement render.
    useEffect(() => {
      function tryFocus() {
        const el = inputRef.current;
        if (!el) return;
        if (document.activeElement !== el) el.focus();
      }
      tryFocus();
      const raf = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(raf);
    }, []);

    // Keep the highlighted row scrolled into view when navigating with
    // arrow keys.
    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-row-idx="${highlightIdx}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }, [highlightIdx]);

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) =>
          filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cls = filtered[highlightIdx];
        if (cls) onPick(cls.id);
      }
    }

    const hasQuery = query.trim().length > 0;
    return (
      <div className="mb-1" data-testid="ctx-class-search-section">
        <div className="px-1 pb-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            autoFocus
            placeholder={`Search ${classes.length} classes…`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            data-testid="ctx-change-class-search"
            className={cn(
              "w-full h-7 px-2 text-[12px] tracking-tight",
              "rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
              "bg-[var(--bg-app)] text-[color:var(--text-primary)]",
              "focus:outline-none focus:border-[var(--accent)]",
            )}
          />
        </div>
        {/* Results only appear once the user starts typing — keeps the
            menu compact when right-clicking, and prevents the "6 random
            classes" preview from cluttering the menu. */}
        {hasQuery && (
        <div
          ref={listRef}
          className="max-h-[220px] overflow-y-auto"
        >
          {filtered.length === 0 ? (
            <div className="px-2 py-2 text-[11.5px] text-[color:var(--text-tertiary)] italic">
              No classes match "{query}"
            </div>
          ) : (
            filtered.map((c, i) => {
              const active = c.id === activeClassId;
              const highlighted = i === highlightIdx;
              return (
                <button
                  key={c.id}
                  type="button"
                  data-testid={`ctx-change-class-${c.id}`}
                  data-row-idx={i}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => onPick(c.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12px] text-left cursor-pointer",
                    active
                      ? "bg-[var(--accent-bg)] text-[color:var(--accent)]"
                      : highlighted
                        ? "bg-[var(--bg-hover)] text-[color:var(--text-primary)]"
                        : "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                    style={{ background: c.color }}
                  />
                  {typeof c.idx === "number" && c.idx >= 0 && c.idx < 9 && (
                    <span className="font-mono text-[10px] text-[color:var(--text-tertiary)] w-3 text-right">
                      {c.idx + 1}
                    </span>
                  )}
                  <span className="flex-1 truncate">{c.name}</span>
                </button>
              );
            })
          )}
        </div>
        )}
      </div>
    );
}

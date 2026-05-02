// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { applyVertexDelete, POLY_MIN_VERTICES } from "@/canvas/polygonEdit";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";
import type { ClassRow } from "@/api/classes";

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  hotkey?: string;
  onSelect: (annId: string) => void;
}

const Z_ITEMS: MenuItem[] = [
  {
    key: "front",
    label: "Bring to Front",
    icon: <ChevronsUp className="h-3.5 w-3.5" />,
    hotkey: "⌘⇧]",
    onSelect: (id) => useAnnotations.getState().bringToFront(id),
  },
  {
    key: "forward",
    label: "Bring Forward",
    icon: <ChevronUp className="h-3.5 w-3.5" />,
    hotkey: "⌘]",
    onSelect: (id) => useAnnotations.getState().bringForward(id),
  },
  {
    key: "backward",
    label: "Send Backward",
    icon: <ChevronDown className="h-3.5 w-3.5" />,
    hotkey: "⌘[",
    onSelect: (id) => useAnnotations.getState().sendBackward(id),
  },
  {
    key: "back",
    label: "Send to Back",
    icon: <ChevronsDown className="h-3.5 w-3.5" />,
    hotkey: "⌘⇧[",
    onSelect: (id) => useAnnotations.getState().sendToBack(id),
  },
];

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
      onClick={() => {
        if (disabled) return;
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
export function AnnotationContextMenu({
  hostRef,
  hitTest,
  vertexHitTest,
  classes,
  toImageXY,
  frameId = null,
  imageBounds,
}: Props) {
  const [state, setState] = useState<MenuState | null>(null);
  const [classMenuOpen, setClassMenuOpen] = useState(false);
  const [submenuLeft, setSubmenuLeft] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
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
        if (!me.shiftKey) {
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
    if (!state) return;
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
        className={cn(
          "fixed z-[1100] min-w-[220px]",
          "rounded-[var(--radius-md)]",
          "glass-surface-strong p-1",
        )}
        style={menuStyle}
      >
        <MenuButton
          testId="ctx-paste"
          icon={<ClipboardIcon className="h-3.5 w-3.5" />}
          label="Paste annotation"
          hotkey="⌘V"
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
      className={cn(
        "fixed z-[1100] min-w-[220px]",
        "rounded-[var(--radius-md)]",
        "glass-surface-strong p-1",
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
                "absolute top-0 min-w-[180px] max-h-[260px] overflow-y-auto",
                submenuLeft ? "left-full ml-1" : "right-full mr-1",
                "rounded-[var(--radius-md)]",
                "glass-surface-strong p-1",
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
          isLocked ? (
            <Unlock className="h-3.5 w-3.5" />
          ) : (
            <Lock className="h-3.5 w-3.5" />
          )
        }
        label={isLocked ? "Unlock" : "Lock"}
        hotkey="L"
        onClick={() => {
          useAnnotations.getState().toggleLock(annId);
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
        hotkey="⌘D"
        onClick={() => {
          useAnnotations.getState().duplicate(annId, 16, 16, imageBounds);
          close();
        }}
      />
      <MenuButton
        testId="ctx-copy"
        icon={<Copy className="h-3.5 w-3.5" />}
        label="Copy"
        hotkey="⌘C"
        onClick={() => {
          useAnnotations.getState().copyToClipboard(annId);
          close();
        }}
      />
      <MenuButton
        testId="ctx-paste-here"
        icon={<ClipboardIcon className="h-3.5 w-3.5" />}
        label="Paste annotation"
        hotkey="⌘V"
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

      <div className="my-1 h-px bg-[var(--border-subtle)]" />

      <MenuButton
        testId="ctx-reveal"
        icon={<Eye className="h-3.5 w-3.5" />}
        label="Reveal in panel"
        onClick={() => {
          useAnnotations.getState().select(annId);
          const row = document.querySelector<HTMLElement>(
            `[data-testid="object-row-${annId}"]`,
          );
          if (row) {
            row.scrollIntoView({ behavior: "smooth", block: "nearest" });
            row.classList.add("ring-2", "ring-[color:var(--accent)]");
            setTimeout(() => {
              row.classList.remove("ring-2", "ring-[color:var(--accent)]");
            }, 1500);
          }
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

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  ChevronsDown,
  Trash2,
  Minus,
  Tag as TagIcon,
  ChevronRight,
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

const ITEMS: MenuItem[] = [
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
  /** Element ref to attach contextmenu listener to (the canvas host). */
  hostRef: React.RefObject<HTMLElement | null>;
  /** Hit-testing function provided by parent canvas. */
  hitTest: (clientX: number, clientY: number) => string | null;
  /**
   * Optional secondary hit-test that returns the polygon vertex (annId +
   * vertex index) under the pointer. When present and matched, the menu
   * renders an extra "Delete vertex" entry. Phase A core 3.
   */
  vertexHitTest?: (
    clientX: number,
    clientY: number,
  ) => { annId: string; vertexIndex: number } | null;
  /**
   * Project classes — when provided, the menu adds a "Change class"
   * entry whose submenu lists every class with a color chip. Selecting
   * one calls ``useAnnotations.update(annId, { classId })`` which marks
   * the annotation dirty. Defaults to ``undefined`` (entry hidden).
   */
  classes?: ClassRow[];
}

/**
 * Listens for `contextmenu` on the provided host element and renders a
 * floating menu. Avoids wrapping the host so the host remains the outer
 * element returned by tests / parent components.
 */
export function AnnotationContextMenu({
  hostRef,
  hitTest,
  vertexHitTest,
  classes,
}: Props) {
  const [state, setState] = useState<
    | {
        x: number;
        y: number;
        annId: string;
        /** Set when the right-click landed on a polygon vertex. */
        vertexIndex?: number;
      }
    | null
  >(null);
  const [classMenuOpen, setClassMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function onContextMenu(e: Event) {
      const me = e as MouseEvent;
      // Prefer a vertex hit (more specific) over a body hit.
      const vh = vertexHitTest?.(me.clientX, me.clientY);
      if (vh) {
        me.preventDefault();
        useAnnotations.getState().select(vh.annId);
        setState({
          x: me.clientX,
          y: me.clientY,
          annId: vh.annId,
          vertexIndex: vh.vertexIndex,
        });
        return;
      }
      const annId = hitTest(me.clientX, me.clientY);
      if (!annId) return;
      me.preventDefault();
      useAnnotations.getState().select(annId);
      setState({ x: me.clientX, y: me.clientY, annId });
    }
    host.addEventListener("contextmenu", onContextMenu);
    return () => host.removeEventListener("contextmenu", onContextMenu);
  }, [hostRef, hitTest, vertexHitTest]);

  useEffect(() => {
    if (!state) return;
    function close(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setState(null);
        setClassMenuOpen(false);
      }
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setState(null);
        setClassMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [state]);

  if (!state) return null;
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
      style={{ top: state.y, left: state.x }}
    >
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          data-testid={`ctx-${it.key}`}
          onClick={() => {
            it.onSelect(state.annId);
            setState(null);
          }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)]"
        >
          <span className="text-[color:var(--text-tertiary)]">{it.icon}</span>
          <span className="flex-1">{it.label}</span>
          {it.hotkey && <Kbd>{it.hotkey}</Kbd>}
        </button>
      ))}
      {state.vertexIndex !== undefined && (() => {
        // Only enable the entry when removing the vertex still leaves >= 3
        // vertices — applyVertexDelete is the source of truth for that rule.
        const draft = useAnnotations.getState().byId[state.annId];
        const canDelete =
          draft &&
          draft.geometry.kind === "polygon" &&
          draft.geometry.points.length > POLY_MIN_VERTICES;
        return (
          <>
            <div className="my-1 h-px bg-[var(--border-subtle)]" />
            <button
              type="button"
              data-testid="ctx-delete-vertex"
              disabled={!canDelete}
              onClick={() => {
                if (!canDelete) return;
                const cur = useAnnotations.getState().byId[state.annId];
                if (cur && cur.geometry.kind === "polygon") {
                  const next = applyVertexDelete(
                    cur.geometry,
                    state.vertexIndex!,
                  );
                  useAnnotations
                    .getState()
                    .update(state.annId, { geometry: next });
                }
                setState(null);
              }}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left",
                "hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed",
                "disabled:hover:bg-transparent",
              )}
            >
              <Minus className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              <span className="flex-1">Delete vertex</span>
            </button>
          </>
        );
      })()}
      {classes && classes.length > 0 && (
        <>
          <div className="my-1 h-px bg-[var(--border-subtle)]" />
          <div className="relative">
            <button
              type="button"
              data-testid="ctx-change-class"
              onClick={() => setClassMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={classMenuOpen}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-left hover:bg-[var(--bg-hover)]"
            >
              <TagIcon className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              <span className="flex-1">Change class</span>
              <ChevronRight className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            </button>
            {classMenuOpen && (
              <div
                role="menu"
                aria-label="Change class submenu"
                data-testid="ctx-change-class-submenu"
                className={cn(
                  "absolute left-full top-0 ml-1 min-w-[180px] max-h-[260px] overflow-y-auto",
                  "rounded-[var(--radius-md)]",
                  "glass-surface-strong p-1",
                )}
              >
                {classes.map((c) => {
                  const draft = useAnnotations.getState().byId[state.annId];
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
                            .update(state.annId, { classId: c.id });
                        }
                        setClassMenuOpen(false);
                        setState(null);
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
        </>
      )}
      <div className="my-1 h-px bg-[var(--border-subtle)]" />
      <button
        type="button"
        data-testid="ctx-delete"
        onClick={() => {
          useAnnotations.getState().remove(state.annId);
          setState(null);
        }}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-[color:var(--danger)] hover:bg-[var(--danger-bg)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Delete</span>
        <Kbd>⌫</Kbd>
      </button>
    </div>
  );
}

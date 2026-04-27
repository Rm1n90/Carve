import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  ChevronsDown,
  Trash2,
  Minus,
} from "lucide-react";
import { useAnnotations } from "@/state/annotations";
import { applyVertexDelete, POLY_MIN_VERTICES } from "@/canvas/polygonEdit";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

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
}

/**
 * Listens for `contextmenu` on the provided host element and renders a
 * floating menu. Avoids wrapping the host so the host remains the outer
 * element returned by tests / parent components.
 */
export function AnnotationContextMenu({ hostRef, hitTest, vertexHitTest }: Props) {
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
      }
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setState(null);
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
        "fixed z-[1100] min-w-[220px] p-1",
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)] shadow-[var(--shadow-elev-2)]",
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

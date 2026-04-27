import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  ChevronsDown,
  Trash2,
} from "lucide-react";
import { useAnnotations } from "@/state/annotations";
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
}

/**
 * Listens for `contextmenu` on the provided host element and renders a
 * floating menu. Avoids wrapping the host so the host remains the outer
 * element returned by tests / parent components.
 */
export function AnnotationContextMenu({ hostRef, hitTest }: Props) {
  const [state, setState] = useState<{ x: number; y: number; annId: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function onContextMenu(e: Event) {
      const me = e as MouseEvent;
      const annId = hitTest(me.clientX, me.clientY);
      if (!annId) return;
      me.preventDefault();
      useAnnotations.getState().select(annId);
      setState({ x: me.clientX, y: me.clientY, annId });
    }
    host.addEventListener("contextmenu", onContextMenu);
    return () => host.removeEventListener("contextmenu", onContextMenu);
  }, [hostRef, hitTest]);

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

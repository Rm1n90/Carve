// Armin Mehri — mehri.armin@gmail.com
/**
 * Portal-rendered context menu for thumbnail right-clicks. Single
 * item in v1: "Copy annotations to current asset". Dismisses on Esc,
 * outside mousedown, or scroll. Pinned in the viewport via fixed
 * positioning at the supplied (x, y) — the parent computes that from
 * the contextmenu event's clientX/Y.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ThumbContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
}

export function ThumbContextMenu({
  open,
  x,
  y,
  onClose,
  onCopy,
}: ThumbContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: `${x + 2}px`,
    top: `${y + 4}px`,
    zIndex: 80,
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="thumb-context-menu"
      style={style}
      className={cn(
        "min-w-[220px] py-1",
        "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
        "bg-[var(--bg-elev)] shadow-xl",
        "text-[12.5px] text-[color:var(--text-primary)]",
      )}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopy();
          onClose();
        }}
        data-testid="thumb-context-menu-copy"
        className={cn(
          "w-full text-left flex items-center gap-2 px-3 py-1.5",
          "hover:bg-[var(--bg-hover)]",
        )}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        Copy annotations to current asset
      </button>
    </div>,
    document.body,
  );
}

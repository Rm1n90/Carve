import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

interface ShortcutGroup {
  title: string;
  rows: { keys: string[]; label: string }[];
}

// IMPORTANT: only document shortcuts that are actually wired up in the
// app — see audit bug N. The handlers live in:
//   - EditorToolbar.tsx (V/B/P/M/T/S tool hotkeys, A auto-apply, F fit)
//   - AnnotateAssetPage.tsx (Cmd+S, Cmd+Z, Cmd+Shift+Z, Cmd+A, Backspace,
//     Delete, Cmd+]/[, Cmd+Shift+]/[, ArrowLeft/Right asset nav, Esc)
//   - AnnotationCanvas.tsx (Arrow keys nudge selected bbox; Shift+arrow
//     nudges 10px; Shift+click multi-selects)
//   - PolygonTool.onKeyDown — Enter commits, Esc cancels in-flight polygon
//   - ClassesPanel.tsx — number keys 1..9 switch active class
const GROUPS: ShortcutGroup[] = [
  {
    title: "Tools",
    rows: [
      { keys: ["V"], label: "Drag / select" },
      { keys: ["B"], label: "Bounding box" },
      { keys: ["P"], label: "Polygon" },
      { keys: ["M"], label: "Mask brush" },
      { keys: ["T"], label: "Tag" },
      { keys: ["S"], label: "Smart (SAM)" },
      { keys: ["A"], label: "Auto-apply (smart)" },
    ],
  },
  {
    title: "Editing",
    rows: [
      { keys: ["Enter"], label: "Commit polygon" },
      { keys: ["Esc"], label: "Cancel / clear selection" },
      { keys: ["Delete"], label: "Delete selected" },
      { keys: ["Backspace"], label: "Delete selected" },
      { keys: ["←", "→", "↑", "↓"], label: "Nudge selected bbox" },
      { keys: ["⇧", "+", "arrow"], label: "Nudge by 10px" },
    ],
  },
  {
    title: "Selection",
    rows: [
      { keys: ["1", "..", "9"], label: "Switch active class" },
      { keys: ["⇧", "click"], label: "Multi-select" },
      { keys: ["⌘", "A"], label: "Select all on frame" },
    ],
  },
  {
    title: "Navigation",
    rows: [
      { keys: ["←"], label: "Previous asset" },
      { keys: ["→"], label: "Next asset" },
      { keys: ["F"], label: "Fit to screen" },
    ],
  },
  {
    title: "Z-order",
    rows: [
      { keys: ["⌘", "⇧", "]"], label: "Bring to front" },
      { keys: ["⌘", "⇧", "["], label: "Send to back" },
      { keys: ["⌘", "]"], label: "Bring forward" },
      { keys: ["⌘", "["], label: "Send backward" },
    ],
  },
  {
    title: "Files",
    rows: [
      { keys: ["⌘", "S"], label: "Save now" },
      { keys: ["⌘", "Z"], label: "Undo" },
      { keys: ["⌘", "⇧", "Z"], label: "Redo" },
    ],
  },
];

export function KeyboardCheatSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Show keyboard shortcuts"
        data-testid="cheatsheet-trigger"
        title="Shortcuts (?)"
        onClick={() => setOpen(true)}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]",
          "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        )}
      >
        <Keyboard className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[min(92vw,720px)]">
            <DialogHeader>
              <DialogTitle>Keyboard shortcuts</DialogTitle>
              <DialogDescription>Press ? to toggle this dialog.</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-x-8 gap-y-5">
              {GROUPS.map((g) => (
                <div key={g.title} className="grid gap-2">
                  <p className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)] font-medium">
                    {g.title}
                  </p>
                  <ul className="grid gap-1.5">
                    {g.rows.map((r, i) => (
                      <li
                        key={`${g.title}-${i}`}
                        className="flex items-center justify-between gap-3 text-[12.5px] text-[color:var(--text-secondary)]"
                      >
                        <span className="truncate">{r.label}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          {r.keys.map((k, j) => (
                            <Kbd key={`${i}-${j}`}>{k}</Kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-4 pt-3 border-t border-[var(--border-subtle)] text-[11.5px] text-[color:var(--text-tertiary)] italic">
              More shortcuts coming.
            </p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

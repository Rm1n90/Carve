// Armin Mehri — mehri.armin@gmail.com
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

/**
 * Plan 09 Task 10 — canonical shortcut list, exported as a single
 * source of truth. The `?` hotkey itself is bound in
 * `AnnotationCanvas.tsx` (only when the editor is mounted) and
 * dispatches a `carve:open-cheat-sheet` window CustomEvent that this
 * dialog listens for. Keeping the binding outside this component
 * means it doesn't fire on pages where the cheat sheet isn't even
 * mounted (e.g. project lists), and it's a single point of truth
 * the AnnotationCanvas can suppress when an input has focus.
 */
export type ShortcutGroup = {
  title: string;
  items: { keys: string[]; desc: string }[];
};

// IMPORTANT: only document shortcuts that are actually wired up in the
// app — see audit bug N. The handlers live in:
//   - EditorToolbar.tsx (V/B/P/M/T/S tool hotkeys, A auto-apply, F fit)
//   - AnnotateAssetPage.tsx (Cmd+S, Cmd+Z, Cmd+Shift+Z, Cmd+A, Backspace,
//     Delete, Cmd+]/[, Cmd+Shift+]/[, ArrowLeft/Right asset nav, Esc,
//     Shift+Arrow video frame nav, comma / period frame step, A accept,
//     R reject)
//   - AnnotationCanvas.tsx (Arrow keys nudge selected bbox; Shift+arrow
//     nudges 10px; Shift+click multi-selects; '?' opens this dialog;
//     '[' / ']' brush radius)
//   - PolygonTool.onKeyDown — Enter commits, Esc cancels in-flight polygon
//   - ClassesPanel.tsx — number keys 1..9 switch active class
export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Tool",
    items: [
      { keys: ["V"], desc: "Drag / select" },
      { keys: ["B"], desc: "Bounding box" },
      { keys: ["P"], desc: "Polygon" },
      { keys: ["M"], desc: "Mask brush" },
      { keys: ["T"], desc: "Tag" },
      { keys: ["S"], desc: "Smart (SAM)" },
      { keys: ["A"], desc: "Auto-apply (smart)" },
      { keys: ["F"], desc: "Fit to screen" },
      { keys: ["Enter"], desc: "Commit polygon" },
    ],
  },
  {
    title: "Selection",
    items: [
      { keys: ["⌘", "A"], desc: "Select all on frame" },
      { keys: ["Backspace"], desc: "Delete selected" },
      { keys: ["Delete"], desc: "Delete selected" },
      { keys: ["Esc"], desc: "Cancel / clear selection" },
      { keys: ["⇧", "click"], desc: "Multi-select" },
      { keys: ["1", "..", "9"], desc: "Switch active class" },
      { keys: ["/"], desc: "Open class palette" },
      { keys: ["⌘", "⇧", "C"], desc: "Open class palette (alt)" },
      { keys: ["R"], desc: "Reassign selected to class…" },
      { keys: ["←", "→", "↑", "↓"], desc: "Nudge selected bbox" },
      { keys: ["⇧", "+", "arrow"], desc: "Nudge by 10px" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["←"], desc: "Previous asset" },
      { keys: ["→"], desc: "Next asset" },
      { keys: ["⇧", "←"], desc: "Previous asset (video)" },
      { keys: ["⇧", "→"], desc: "Next asset (video)" },
      { keys: ["["], desc: "Previous frame" },
      { keys: ["]"], desc: "Next frame" },
      { keys: [","], desc: "Step frame back" },
      { keys: ["."], desc: "Step frame forward" },
    ],
  },
  {
    title: "Review",
    items: [
      { keys: ["A"], desc: "Accept selected" },
      { keys: ["R"], desc: "Reject selected" },
    ],
  },
  {
    title: "SAM",
    items: [
      { keys: ["P"], desc: "Point mode" },
      { keys: ["B"], desc: "Box mode" },
      { keys: ["T"], desc: "Text mode" },
      { keys: ["drag"], desc: "Track mode: bbox seed" },
      { keys: ["click"], desc: "Track mode: point seed" },
    ],
  },
  {
    title: "Z-order",
    items: [
      { keys: ["⌘", "⇧", "]"], desc: "Bring to front" },
      { keys: ["⌘", "⇧", "["], desc: "Send to back" },
      { keys: ["⌘", "]"], desc: "Bring forward" },
      { keys: ["⌘", "["], desc: "Send backward" },
    ],
  },
  {
    title: "Files",
    items: [
      { keys: ["⌘", "S"], desc: "Save now" },
      { keys: ["⌘", "Z"], desc: "Undo" },
      { keys: ["⌘", "⇧", "Z"], desc: "Redo" },
      { keys: ["⌘", "D"], desc: "Duplicate selected" },
      { keys: ["L"], desc: "Lock / unlock selected" },
      { keys: ["?"], desc: "Show this cheat sheet" },
    ],
  },
];

// Backwards-compatible alias — the previous ``rows`` / ``label`` shape
// is preserved by mapping in the renderer. The exported canonical
// shape uses ``items`` / ``desc`` (Plan 09 Task 10 spec).

export function KeyboardCheatSheet({
  hideTrigger = false,
}: {
  /**
   * Plan-15 Phase 9 follow-up — when ``true`` the component renders the
   * dialog mount + event listener but no visible button. Used by callers
   * that surface the trigger elsewhere (e.g. the editor toolbar).
   */
  hideTrigger?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onOpen() {
      setOpen((v) => !v);
    }
    // Accept both spellings so legacy dispatchers (without the hyphen)
    // still work alongside the canonical ``carve:open-cheat-sheet``.
    window.addEventListener("carve:open-cheat-sheet", onOpen as EventListener);
    window.addEventListener("carve:open-cheatsheet", onOpen as EventListener);
    return () => {
      window.removeEventListener("carve:open-cheat-sheet", onOpen as EventListener);
      window.removeEventListener("carve:open-cheatsheet", onOpen as EventListener);
    };
  }, []);

  return (
    <>
      {!hideTrigger && (
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
      )}
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[min(92vw,720px)]">
            <DialogHeader>
              <DialogTitle>Keyboard shortcuts</DialogTitle>
              <DialogDescription>Press ? to toggle this dialog.</DialogDescription>
            </DialogHeader>
            <div
              className="grid grid-cols-2 gap-x-8 gap-y-5"
              data-testid="cheatsheet-groups"
            >
              {SHORTCUTS.map((g) => (
                <div key={g.title} className="grid gap-2">
                  <p className="text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)] font-medium">
                    {g.title}
                  </p>
                  <ul className="grid gap-1.5">
                    {g.items.map((r, i) => (
                      <li
                        key={`${g.title}-${i}`}
                        className="flex items-center justify-between gap-3 text-[12.5px] text-[color:var(--text-secondary)]"
                      >
                        <span className="truncate">{r.desc}</span>
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

// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { MOD_LABEL } from "@/lib/platform";
import { chordTokens } from "@/lib/shortcuts/chord";
import { useShortcut } from "@/state/shortcuts";
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
      { keys: [MOD_LABEL, "A"], desc: "Select all on frame" },
      { keys: ["Backspace"], desc: "Delete selected" },
      { keys: ["Delete"], desc: "Delete selected" },
      { keys: ["Esc"], desc: "Cancel / clear selection" },
      { keys: ["⇧", "click"], desc: "Multi-select" },
      { keys: ["1", "..", "9"], desc: "Switch active class" },
      { keys: ["/"], desc: "Open class palette" },
      { keys: [MOD_LABEL, "⇧", "C"], desc: "Open class palette (alt)" },
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
      { keys: [MOD_LABEL, "⇧", "]"], desc: "Bring to front" },
      { keys: [MOD_LABEL, "⇧", "["], desc: "Send to back" },
      { keys: [MOD_LABEL, "]"], desc: "Bring forward" },
      { keys: [MOD_LABEL, "["], desc: "Send backward" },
    ],
  },
  {
    title: "Files",
    items: [
      { keys: [MOD_LABEL, "S"], desc: "Save now" },
      { keys: [MOD_LABEL, "Z"], desc: "Undo" },
      { keys: [MOD_LABEL, "⇧", "Z"], desc: "Redo" },
      { keys: [MOD_LABEL, "D"], desc: "Duplicate selected" },
      { keys: ["L"], desc: "Lock / unlock selected" },
      { keys: ["?"], desc: "Show this cheat sheet" },
    ],
  },
];

// Backwards-compatible alias — the previous ``rows`` / ``label`` shape
// is preserved by mapping in the renderer. The exported canonical
// shape uses ``items`` / ``desc`` (Plan 09 Task 10 spec).

/**
 * v3.20 -- live, per-render shortcut groups. Migrated rows pull their
 * keys through ``useShortcut`` so user overrides are reflected in the
 * cheat sheet immediately. Non-migrated rows fall through to the
 * static ``SHORTCUTS`` definitions above.
 */
function useLiveShortcutGroups(): ShortcutGroup[] {
  const t = {
    select_all: chordTokens(useShortcut("select_all")),
    open_class_palette: chordTokens(useShortcut("open_class_palette")),
    open_class_palette_alt: chordTokens(useShortcut("open_class_palette_alt")),
    reassign_class: chordTokens(useShortcut("reassign_class")),
    convert_to_bbox: chordTokens(useShortcut("convert_to_bbox")),
    bring_to_front: chordTokens(useShortcut("bring_to_front")),
    send_to_back: chordTokens(useShortcut("send_to_back")),
    bring_forward: chordTokens(useShortcut("bring_forward")),
    send_backward: chordTokens(useShortcut("send_backward")),
    undo: chordTokens(useShortcut("undo")),
    redo: chordTokens(useShortcut("redo")),
    copy: chordTokens(useShortcut("copy")),
    paste: chordTokens(useShortcut("paste")),
    duplicate: chordTokens(useShortcut("duplicate")),
    frame_prev: chordTokens(useShortcut("frame_prev")),
    frame_next: chordTokens(useShortcut("frame_next")),
    frame_prev_bracket: chordTokens(useShortcut("frame_prev_bracket")),
    frame_next_bracket: chordTokens(useShortcut("frame_next_bracket")),
    frame_prev_comma: chordTokens(useShortcut("frame_prev_comma")),
    frame_next_period: chordTokens(useShortcut("frame_next_period")),
    frame_play_pause: chordTokens(useShortcut("frame_play_pause")),
    global_search: chordTokens(useShortcut("global_search")),
    tool_cursor: chordTokens(useShortcut("tool_cursor")),
    tool_bbox: chordTokens(useShortcut("tool_bbox")),
    tool_polygon: chordTokens(useShortcut("tool_polygon")),
    tool_mask: chordTokens(useShortcut("tool_mask")),
    tool_tag: chordTokens(useShortcut("tool_tag")),
    tool_sam: chordTokens(useShortcut("tool_sam")),
    delete_annotation: chordTokens(useShortcut("delete_annotation")),
    save_annotations: chordTokens(useShortcut("save_annotations")),
    pin_class: chordTokens(useShortcut("pin_class")),
    review_accept: chordTokens(useShortcut("review_accept")),
    review_reject: chordTokens(useShortcut("review_reject")),
    select_all_assets: chordTokens(useShortcut("select_all_assets")),
    group_assets: chordTokens(useShortcut("group_assets")),
  };
  return useMemo<ShortcutGroup[]>(
    () => [
      {
        title: "Tool",
        items: [
          { keys: t.tool_cursor, desc: "Drag / select" },
          { keys: t.tool_bbox, desc: "Bounding box" },
          { keys: t.tool_polygon, desc: "Polygon" },
          { keys: t.tool_mask, desc: "Mask brush" },
          { keys: t.tool_tag, desc: "Tag" },
          { keys: t.tool_sam, desc: "Smart (SAM)" },
          { keys: ["A"], desc: "Auto-apply (smart)" },
          { keys: ["F"], desc: "Fit to screen" },
          { keys: ["Enter"], desc: "Commit polygon" },
        ],
      },
      {
        title: "Selection",
        items: [
          { keys: t.select_all, desc: "Select all on frame" },
          { keys: t.delete_annotation, desc: "Delete selected" },
          { keys: ["Esc"], desc: "Cancel / clear selection" },
          { keys: ["⇧", "click"], desc: "Multi-select" },
          { keys: ["1", "..", "9"], desc: "Switch active class" },
          { keys: t.open_class_palette, desc: "Open class palette" },
          { keys: t.open_class_palette_alt, desc: "Open class palette (alt)" },
          { keys: t.pin_class, desc: "Pin highlighted class" },
          { keys: t.reassign_class, desc: "Reassign selected to class…" },
          { keys: t.convert_to_bbox, desc: "Convert selected to BBox" },
          { keys: ["←", "→", "↑", "↓"], desc: "Nudge selected bbox" },
          { keys: ["⇧", "+", "arrow"], desc: "Nudge by 10px" },
        ],
      },
      {
        title: "Navigation",
        items: [
          { keys: t.frame_prev, desc: "Previous asset / frame" },
          { keys: t.frame_next, desc: "Next asset / frame" },
          { keys: ["⇧", "←"], desc: "Previous asset (video)" },
          { keys: ["⇧", "→"], desc: "Next asset (video)" },
          { keys: t.frame_prev_bracket, desc: "Previous frame" },
          { keys: t.frame_next_bracket, desc: "Next frame" },
          { keys: t.frame_prev_comma, desc: "Step frame back" },
          { keys: t.frame_next_period, desc: "Step frame forward" },
          { keys: t.frame_play_pause, desc: "Play / pause" },
        ],
      },
      {
        title: "Review",
        items: [
          { keys: t.review_accept, desc: "Accept selected" },
          { keys: t.review_reject, desc: "Reject selected" },
        ],
      },
      {
        title: "Assets",
        items: [
          { keys: t.select_all_assets, desc: "Select all assets in grid" },
          { keys: t.group_assets, desc: "Jump to asset by index" },
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
          { keys: t.bring_to_front, desc: "Bring to front" },
          { keys: t.send_to_back, desc: "Send to back" },
          { keys: t.bring_forward, desc: "Bring forward" },
          { keys: t.send_backward, desc: "Send backward" },
        ],
      },
      {
        title: "Files",
        items: [
          { keys: t.save_annotations, desc: "Save now" },
          { keys: t.undo, desc: "Undo" },
          { keys: t.redo, desc: "Redo" },
          { keys: t.copy, desc: "Copy selected" },
          { keys: t.paste, desc: "Paste" },
          { keys: t.duplicate, desc: "Duplicate selected" },
          { keys: t.global_search, desc: "Global search" },
          { keys: ["L"], desc: "Lock / unlock selected" },
          { keys: ["?"], desc: "Show this cheat sheet" },
        ],
      },
    ],
    // The token arrays change identity when overrides change; tracking
    // them collectively via JSON.stringify keeps the memo cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(t)],
  );
}

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
  const liveGroups = useLiveShortcutGroups();

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
              {liveGroups.map((g) => (
                <div key={g.title} className="grid gap-2">
                  <p className="text-[10.5px] tracking-tight text-[color:var(--text-tertiary)] font-medium">
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

// Armin Mehri -- mehri.armin@gmail.com
//
// Single source of truth for every customizable keyboard action.
//
// The ``id`` matches the backend regex (``^[a-z][a-z0-9_]{0,63}$``) and
// is what gets stored in ``users.shortcut_overrides``. The ``default``
// chord is in the canonical normalized format (see ``chord.ts``).
//
// IMPORTANT -- default chord uniqueness:
//   No two actions in this catalog may share the same default chord.
//   The settings page enforces conflict-free user overrides too. If you
//   add a new action, pick a chord that doesn't already appear above.
//
// Shortcuts not in this catalog are NOT user-customizable -- e.g.
// numeric class switch (1..9), modifier-while-drawing (Shift to
// constrain), and dialog-local Esc/Enter/Arrow handlers. Those remain
// system-managed.

export type ShortcutCategory =
  | "Global"
  | "Editor"
  | "Tools"
  | "Navigation"
  | "Z-order"
  | "Selection"
  | "Review"
  | "Assets";

export interface ShortcutAction {
  /** Stable, lowercase identifier. Persisted in user overrides. */
  id: string;
  /** Human-readable label for the settings list and tooltips. */
  label: string;
  /** Group used in the settings page layout. */
  category: ShortcutCategory;
  /** Default chord (canonical normalized format). */
  default: string;
  /** Longer hover hint, optional. */
  description?: string;
}

const list: ShortcutAction[] = [
  // ---------------- Global ----------------
  {
    id: "global_search",
    label: "Open global search",
    category: "Global",
    default: "mod+k",
    description: "Open the workspace command palette from anywhere.",
  },

  // ---------------- Tools ----------------
  {
    id: "tool_cursor",
    label: "Select tool",
    category: "Tools",
    default: "v",
    description: "Switch to the drag/select tool.",
  },
  {
    id: "tool_bbox",
    label: "Bounding box tool",
    category: "Tools",
    default: "b",
    description: "Switch to the bounding box tool.",
  },
  {
    id: "tool_polygon",
    label: "Polygon tool",
    category: "Tools",
    default: "p",
    description: "Switch to the polygon tool.",
  },
  {
    id: "tool_mask",
    label: "Mask brush tool",
    category: "Tools",
    default: "m",
    description: "Switch to the mask brush tool.",
  },
  {
    id: "tool_tag",
    label: "Tag tool",
    category: "Tools",
    default: "t",
    description: "Switch to the whole-frame tag tool.",
  },
  {
    id: "tool_sam",
    label: "SAM (magic wand) tool",
    category: "Tools",
    default: "s",
    description: "Switch to the SAM smart-select tool.",
  },

  // ---------------- Editor ----------------
  {
    id: "convert_to_bbox",
    label: "Convert selected to BBox",
    category: "Editor",
    default: "c",
    description:
      "Replace each selected polygon or mask with its tight bounding box.",
  },
  {
    id: "open_class_palette",
    label: "Open class palette",
    category: "Editor",
    default: "slash",
    description: "Pick the active class for the next annotation.",
  },
  {
    id: "open_class_palette_alt",
    label: "Open class palette (alt)",
    category: "Editor",
    default: "mod+shift+c",
    description: "Power-user alias for opening the class palette.",
  },
  {
    id: "reassign_class",
    label: "Reassign class",
    category: "Editor",
    default: "r",
    description: "Reassign the selected annotation(s) to a different class.",
  },
  {
    id: "delete_annotation",
    label: "Delete selected annotation(s)",
    category: "Editor",
    default: "backspace",
    description: "Remove every selected annotation from the current frame.",
  },
  {
    id: "save_annotations",
    label: "Save annotations",
    category: "Editor",
    default: "mod+s",
    description: "Force a save of any pending annotation changes.",
  },
  {
    id: "pin_class",
    label: "Pin class in palette",
    category: "Editor",
    default: "mod+p",
    description:
      "Pin/unpin the highlighted class while the class palette is open.",
  },
  {
    id: "undo",
    label: "Undo",
    category: "Editor",
    default: "mod+z",
  },
  {
    id: "redo",
    label: "Redo",
    category: "Editor",
    default: "mod+shift+z",
  },

  // ---------------- Selection ----------------
  {
    id: "select_all",
    label: "Select all on frame",
    category: "Selection",
    default: "mod+a",
  },
  {
    id: "copy",
    label: "Copy selection",
    category: "Selection",
    default: "mod+c",
  },
  {
    id: "paste",
    label: "Paste",
    category: "Selection",
    default: "mod+v",
  },
  {
    id: "duplicate",
    label: "Duplicate selection",
    category: "Selection",
    default: "mod+d",
  },
  {
    id: "copy_from_previous_asset",
    label: "Copy annotations from previous asset",
    category: "Editor",
    default: "mod+shift+d",
    description:
      "Duplicate every annotation from the previous asset onto the current one. Sequential / similar-image datasets become 5–10× faster.",
  },
  {
    id: "skip_next_empty",
    label: "Next empty asset",
    category: "Navigation",
    default: "pagedown",
    description: "Jump to the next asset with no annotations.",
  },
  {
    id: "skip_prev_empty",
    label: "Previous empty asset",
    category: "Navigation",
    default: "pageup",
    description: "Jump to the previous asset with no annotations.",
  },
  {
    id: "skip_next_unreviewed",
    label: "Next unreviewed asset",
    category: "Navigation",
    default: "shift+pagedown",
    description:
      "Jump to the next asset that still has at least one non-accepted annotation.",
  },
  {
    id: "skip_prev_unreviewed",
    label: "Previous unreviewed asset",
    category: "Navigation",
    default: "shift+pageup",
    description:
      "Jump to the previous asset that still has at least one non-accepted annotation.",
  },

  // ---------------- Z-order ----------------
  {
    id: "bring_to_front",
    label: "Bring to front",
    category: "Z-order",
    default: "mod+shift+bracketright",
  },
  {
    id: "send_to_back",
    label: "Send to back",
    category: "Z-order",
    default: "mod+shift+bracketleft",
  },
  {
    id: "bring_forward",
    label: "Bring forward",
    category: "Z-order",
    default: "mod+bracketright",
  },
  {
    id: "send_backward",
    label: "Send backward",
    category: "Z-order",
    default: "mod+bracketleft",
  },

  // ---------------- Navigation ----------------
  {
    id: "frame_prev",
    label: "Previous frame/asset",
    category: "Navigation",
    default: "arrowleft",
  },
  {
    id: "frame_next",
    label: "Next frame/asset",
    category: "Navigation",
    default: "arrowright",
  },
  {
    id: "frame_prev_bracket",
    label: "Previous frame (bracket)",
    category: "Navigation",
    default: "bracketleft",
    description: "Step backward one frame on a video asset.",
  },
  {
    id: "frame_next_bracket",
    label: "Next frame (bracket)",
    category: "Navigation",
    default: "bracketright",
    description: "Step forward one frame on a video asset.",
  },
  {
    id: "frame_prev_comma",
    label: "Previous frame (comma)",
    category: "Navigation",
    default: "comma",
    description: "Alternate frame-back shortcut (matches video editors).",
  },
  {
    id: "frame_next_period",
    label: "Next frame (period)",
    category: "Navigation",
    default: "period",
    description: "Alternate frame-forward shortcut (matches video editors).",
  },
  {
    id: "frame_play_pause",
    label: "Play / pause",
    category: "Navigation",
    default: "space",
    description: "Auto-play through frames at the configured player speed.",
  },

  // ---------------- Review ----------------
  {
    id: "review_accept",
    label: "Accept review",
    category: "Review",
    default: "y",
    description:
      "Mark the selected annotation as accepted in the review panel.",
  },
  {
    id: "review_reject",
    label: "Reject review",
    category: "Review",
    default: "j",
    description:
      "Mark the selected annotation as rejected in the review panel.",
  },

  // ---------------- Assets ----------------
  {
    id: "select_all_assets",
    label: "Select all assets in grid",
    category: "Assets",
    default: "mod+shift+a",
    description: "Select every visible asset in the asset grid.",
  },
  {
    id: "group_assets",
    label: "Jump to asset by index",
    category: "Assets",
    default: "g",
    description: "Open the jump-to-asset prompt in the asset strip.",
  },
];

// ----------------------------------------------------------------------
// Default-conflict guard. Catches developer mistakes at module load
// time -- if two actions share a default chord the app can't sensibly
// enforce conflict-free overrides. We surface it loudly in dev so the
// problem doesn't slip through code review.
// ----------------------------------------------------------------------
{
  const seen = new Map<string, string>();
  for (const a of list) {
    if (!a.default) continue;
    const prev = seen.get(a.default);
    if (prev) {
      throw new Error(
        `[shortcuts] default chord conflict: "${a.default}" is bound to both ` +
          `"${prev}" and "${a.id}". Pick a unique default.`,
      );
    }
    seen.set(a.default, a.id);
  }
}

export const ACTIONS: Record<string, ShortcutAction> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

/** Stable category order used by the settings page. */
export const CATEGORY_ORDER: ShortcutCategory[] = [
  "Global",
  "Tools",
  "Editor",
  "Selection",
  "Z-order",
  "Navigation",
  "Review",
  "Assets",
];

/** Iterate actions grouped by category in stable order. */
export function actionsByCategory(): {
  category: ShortcutCategory;
  actions: ShortcutAction[];
}[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    actions: list.filter((a) => a.category === category),
  }));
}

/** Type-safe id list for callers. */
export type ShortcutActionId = string;

// ----------------------------------------------------------------------
// Conflict detection helpers shared by the settings UI.
// ----------------------------------------------------------------------

/**
 * Resolve every action's currently-effective chord (override OR default)
 * keyed by action id. ``overrides`` may be a sparse map -- missing
 * entries fall through to the action's default.
 */
export function resolveAllChords(
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(ACTIONS)) {
    const o = overrides[id];
    out[id] = typeof o === "string" ? o : ACTIONS[id].default;
  }
  return out;
}

/**
 * Return the action id (other than ``selfId``) whose effective chord
 * equals ``chord``. ``null`` when there is no conflict. Empty chords
 * never conflict (they're the unbound sentinel).
 */
export function findConflict(
  chord: string,
  selfId: string,
  overrides: Record<string, string>,
): string | null {
  if (!chord) return null;
  for (const id of Object.keys(ACTIONS)) {
    if (id === selfId) continue;
    const eff = typeof overrides[id] === "string" ? overrides[id] : ACTIONS[id].default;
    if (eff === chord) return id;
  }
  return null;
}

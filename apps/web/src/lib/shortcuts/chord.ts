// Armin Mehri -- mehri.armin@gmail.com
//
// Chord normalization, matching, formatting and validation.
//
// Internal chord format (matches the backend wire format exactly):
//   - lowercase
//   - modifiers sorted alphabetically: alt, mod, shift
//   - tokens joined with "+"
//   - "mod" is platform-agnostic (resolves to metaKey on mac, ctrlKey
//     elsewhere when matching events)
//
// Examples: "mod+shift+z", "mod+k", "c", "slash", "f1", "arrowleft"
//
// Display format is produced by ``formatChord``: ⌘/Ctrl, ⌥/Alt, ⇧/Shift
// using existing ``MOD_LABEL`` / ``ALT_LABEL`` / ``SHIFT_LABEL`` from
// ``platform.ts``.
import { ALT_LABEL, MOD_LABEL, SHIFT_LABEL } from "@/lib/platform";

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

/** Modifiers we expose; sort order matches normalization output. */
const MODIFIER_ORDER = ["alt", "mod", "shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/**
 * Map ``KeyboardEvent.key`` values that don't trivially map to lowercase
 * letters/digits to their canonical chord token. Keep the table small
 * and explicit -- everything else falls through to ``key.toLowerCase()``.
 */
const SPECIAL_KEY_MAP: Record<string, string> = {
  " ": "space",
  Spacebar: "space",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  Escape: "escape",
  Esc: "escape",
  Enter: "enter",
  Return: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  "/": "slash",
  "\\": "backslash",
  "[": "bracketleft",
  "]": "bracketright",
  ",": "comma",
  ".": "period",
  ";": "semicolon",
  "'": "quote",
  "`": "backtick",
  "-": "minus",
  "=": "equal",
};

// Modifier-only key.code values produced when the user releases or
// presses just a modifier. ``normalizeKeyboardEvent`` returns null for
// these so we don't accidentally bind "shift" alone as a chord.
const MODIFIER_KEY_NAMES = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
]);

// ----------------------------------------------------------------------
// Normalization
// ----------------------------------------------------------------------

/**
 * Build the canonical chord string from a captured ``KeyboardEvent``.
 *
 * Returns ``null`` when the only thing the user pressed was a modifier
 * (so the capture UI can keep waiting).
 */
export function normalizeKeyboardEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEY_NAMES.has(e.key)) {
    return null;
  }
  const keysym = keysymFromEvent(e);
  if (!keysym) return null;

  const mods: Modifier[] = [];
  if (e.altKey) mods.push("alt");
  if (e.metaKey || e.ctrlKey) mods.push("mod");
  if (e.shiftKey) mods.push("shift");

  // Stable order: alphabetical by enum order. The MODIFIER_ORDER tuple
  // is already alphabetical so we filter against it to preserve order
  // without an in-place sort.
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return [...ordered, keysym].join("+");
}

function keysymFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k) return null;
  if (k in SPECIAL_KEY_MAP) return SPECIAL_KEY_MAP[k];
  // Function keys F1..F24
  if (/^F\d{1,2}$/.test(k)) return k.toLowerCase();
  // Single character: letters and digits collapse to lowercase
  if (k.length === 1) {
    return k.toLowerCase();
  }
  // Catch-all: long key name (e.g. "PageUp") -> lowercase
  return k.toLowerCase();
}

// ----------------------------------------------------------------------
// Matching
// ----------------------------------------------------------------------

/**
 * Return ``true`` when the keyboard event matches the chord exactly.
 * Modifier set must match -- no extras allowed. ``mod`` matches either
 * Cmd or Ctrl.
 *
 * When focus is in an INPUT/TEXTAREA/contenteditable, only chords that
 * include ``mod`` are allowed to fire (so Cmd+S still works while you
 * type, but plain "c" doesn't).
 */
export function matchChord(e: KeyboardEvent, chord: string): boolean {
  if (!chord) return false; // empty string is the "unbound" sentinel
  if (!isValidChord(chord)) return false;

  // v3.24.2 — global shortcut suppression while ANY modal dialog is
  // open. Radix Dialog primitives render with role="dialog" +
  // data-state="open" while mounted; their presence means the user
  // is interacting with a modal layer, so global editor shortcuts
  // (frame nav, asset nav, save, undo, etc.) should NOT fire.
  // Without this, opening the YOLOE / Auto / YOLO Predict dialog
  // left the canvas as the keyboard target, so ArrowLeft/Right
  // navigated the editor instead of doing nothing while the modal
  // collected input.
  // Esc still works because Radix attaches its own listener (not
  // via this dispatcher), and dialog-internal shortcuts wired with
  // local onKeyDown still work since they run on the dialog's own
  // events before bubbling to window.
  if (typeof document !== "undefined") {
    const openDialog = document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    );
    if (openDialog) return false;
  }

  const target = e.target as HTMLElement | null;
  const inEditable =
    !!target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);

  const tokens = chord.split("+");
  const keysym = tokens[tokens.length - 1];
  const expectedMods = new Set(tokens.slice(0, -1));

  if (inEditable && !expectedMods.has("mod")) {
    return false;
  }

  // Modifier set must match exactly.
  const actualMod = e.metaKey || e.ctrlKey;
  if (expectedMods.has("mod") !== actualMod) return false;
  if (expectedMods.has("alt") !== e.altKey) return false;
  if (expectedMods.has("shift") !== e.shiftKey) return false;

  const actualKeysym = keysymFromEvent(e);
  if (actualKeysym === null) return false;
  return actualKeysym === keysym;
}

// ----------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------

const KEY_DISPLAY: Record<string, string> = {
  slash: "/",
  backslash: "\\",
  bracketleft: "[",
  bracketright: "]",
  comma: ",",
  period: ".",
  semicolon: ";",
  quote: "'",
  backtick: "`",
  minus: "-",
  equal: "=",
  space: "Space",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Del",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

/**
 * Render the chord as a human-readable display string. Uses platform
 * labels (⌘ vs Ctrl, etc.) and pretty-prints special keys.
 */
export function formatChord(chord: string): string {
  if (!chord) return "Unbound";
  const tokens = chord.split("+");
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "mod") out.push(MOD_LABEL);
    else if (t === "alt") out.push(ALT_LABEL);
    else if (t === "shift") out.push(SHIFT_LABEL);
    else if (KEY_DISPLAY[t]) out.push(KEY_DISPLAY[t]);
    else if (/^f\d{1,2}$/.test(t)) out.push(t.toUpperCase());
    else if (t.length === 1) out.push(t.toUpperCase());
    else out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  // Use a thin space between symbolic modifier glyphs (Mac), and a
  // plus sign on platforms where modifiers are spelled out (e.g. "Ctrl
  // + Shift + Z" is more readable than "Ctrl Shift Z").
  const useGlyphs = MOD_LABEL === "⌘";
  return out.join(useGlyphs ? " " : " + ");
}

/**
 * Split a chord into its display tokens (for rendering with separate
 * <Kbd> chips). Returns the same labels ``formatChord`` uses, in
 * order, but without any separator.
 */
export function chordTokens(chord: string): string[] {
  if (!chord) return ["Unbound"];
  const tokens = chord.split("+");
  return tokens.map((t) => {
    if (t === "mod") return MOD_LABEL;
    if (t === "alt") return ALT_LABEL;
    if (t === "shift") return SHIFT_LABEL;
    if (KEY_DISPLAY[t]) return KEY_DISPLAY[t];
    if (/^f\d{1,2}$/.test(t)) return t.toUpperCase();
    if (t.length === 1) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  });
}

// ----------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------

const CHORD_RE = /^([a-z]+\+)*[a-z0-9]+$/;
const ALLOWED_MODS = new Set(["mod", "alt", "shift"]);

export function isValidChord(chord: string): boolean {
  // Empty string is the "unbound" sentinel; treat as not-firing rather
  // than invalid so the capture flow can use it.
  if (chord === "") return true;
  if (!CHORD_RE.test(chord)) return false;
  const parts = chord.split("+");
  const mods = parts.slice(0, -1);
  for (const m of mods) {
    if (!ALLOWED_MODS.has(m)) return false;
  }
  // No duplicate modifiers.
  if (new Set(mods).size !== mods.length) return false;
  return true;
}

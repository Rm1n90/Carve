// Armin Mehri — mehri.armin@gmail.com
//
// Platform-aware modifier-key labels. The keyboard handlers across the
// app already check `e.metaKey || e.ctrlKey` so the wiring is correct on
// every OS — only the user-visible hotkey labels were Mac-only. These
// helpers swap "⌘" / "⌥" for the platform-appropriate label without
// touching any handler logic.
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator.platform ?? "") || (navigator.userAgent ?? ""),
  );

/** Display label for the modifier key — "⌘" on Mac, "Ctrl" elsewhere. */
export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

/** Display label for the alt key — "⌥" on Mac, "Alt" elsewhere. */
export const ALT_LABEL = isMac ? "⌥" : "Alt";

/** Display label for shift — universally "⇧" but exposed for symmetry. */
export const SHIFT_LABEL = isMac ? "⇧" : "Shift";

/**
 * Replace any "⌘" / "⌥" tokens in a hotkey display string with the
 * platform-appropriate label. Useful for short hotkey strings stored as
 * static data (e.g. "⌘⇧]").
 */
export function localizeHotkey(label: string): string {
  return label
    .replace(/⌘/g, isMac ? "⌘" : "Ctrl")
    .replace(/⌥/g, isMac ? "⌥" : "Alt");
}

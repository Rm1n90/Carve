// Armin Mehri — mehri.armin@gmail.com
/**
 * Predicate for the "open keyboard cheat sheet" hotkey.
 *
 * The cheat sheet opens on the ``?`` character. Two paths:
 *   1. ``e.key === "?"`` — covers any layout where the user actually
 *      typed a literal question mark (US Shift+/, German Shift+ß, …).
 *   2. ``e.shiftKey && e.code === "Slash"`` — the legacy explicit
 *      ``Shift+/`` path, but checked against the *physical* slash key
 *      so it doesn't fire on layouts where Shift+digit happens to
 *      produce ``/`` as e.key (German QWERTZ Shift+7).
 *
 * Physical digit keys (Digit1..9, Numpad1..9) are always excluded so
 * the class-binding flow (Shift+digit → bind/unbind) wins over the
 * cheat sheet on every layout.
 *
 * Pure — no DOM access — so it tests cleanly in isolation.
 */
export interface CheatSheetKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
}

export function shouldOpenCheatSheet(e: CheatSheetKeyEvent): boolean {
  if (/^(?:Digit|Numpad)[1-9]$/.test(e.code)) return false;
  if (e.key === "?") return true;
  if (e.shiftKey && e.code === "Slash") return true;
  return false;
}

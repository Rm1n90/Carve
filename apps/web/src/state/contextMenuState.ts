// Armin Mehri — mehri.armin@gmail.com
//
// Plan-17 — tiny shared flag so the AnnotationCanvas pointer-down
// handler can tell when the AnnotationContextMenu is currently mounted
// and visible. Used to suppress SAM positive/negative-point clicks on
// the dismiss-by-clicking-outside gesture; without this guard the
// click that closes the menu would also fire SAM behaviour on the
// canvas underneath.
let _open = false;
let _justClosedAt = 0;

export function setContextMenuOpen(open: boolean): void {
  if (_open && !open) {
    // Stamp the close transition so a click that fires within a tiny
    // window after closing (the same dismiss event) is also suppressed.
    _justClosedAt = performance.now();
  }
  _open = open;
}

export function isContextMenuOpen(): boolean {
  return _open;
}

/**
 * True when the menu is open OR was open within the last ``windowMs``
 * milliseconds. Lets the canvas swallow the pointerdown that triggered
 * the dismiss without also processing it as a SAM click.
 */
export function isContextMenuOpenOrJustClosed(windowMs = 150): boolean {
  return _open || performance.now() - _justClosedAt < windowMs;
}

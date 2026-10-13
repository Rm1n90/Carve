// Armin Mehri — mehri.armin@gmail.com
//
// A tab opened before a deploy still asks for the code chunks of the
// build it was loaded with. A deploy replaces them (every file name
// carries its content hash), so the next page that loads one fails
// with "Failed to fetch dynamically imported module". The fix is the
// new index.html, which is never cached: reload once and the tab is on
// the new build, at the page it was going to.
//
// A failure again right after that reload means the chunk is not the
// problem (the network is down, or the file is missing from the new
// build too), so the error is shown instead of reloading in a loop.
import { lazy, type ComponentType } from "react";

const RELOADED_AT_KEY = "carve:chunk-reload-at";
/** A second chunk failure within this time of a reload is shown. */
export const RELOAD_GUARD_MS = 30_000;

// Chrome / Edge, Firefox, Safari, and Vite's preload of a chunk's CSS.
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

let reloading = false;

/** What reloads the page (jsdom's ``location`` cannot be stubbed). */
export const page = { reload: () => window.location.reload() };

export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return CHUNK_ERROR.test(message);
}

/**
 * Reload the page to pick up the new build. False when it is not
 * done: a reload already happened moments ago, or the tab cannot
 * remember that it did (no session storage), which would risk a loop.
 */
export function reloadForNewBuild(): boolean {
  if (reloading) return true;
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED_AT_KEY) ?? 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reloading = true;
  page.reload();
  return true;
}

/**
 * ``React.lazy`` that reloads the page when the chunk is from an older
 * build. While the page reloads the component never resolves, so the
 * Suspense fallback stays up instead of an error flashing.
 */
// The same signature as ``React.lazy``, so the props are inferred.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (reloading || (isChunkLoadError(err) && reloadForNewBuild())) {
        return new Promise<never>(() => {});
      }
      throw err;
    }),
  );
}

/**
 * The same for every other dynamic import (pixi.js, the SAM decoder):
 * Vite reports each failed one as ``vite:preloadError``. The import
 * still fails for its caller; the page is reloading by then.
 */
export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (isChunkLoadError(payload)) reloadForNewBuild();
  });
}

/** Tests only: forget that a reload was started. */
export function _resetChunkReloadForTests(): void {
  reloading = false;
}

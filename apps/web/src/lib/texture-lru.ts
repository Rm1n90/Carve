// Armin Mehri — mehri.armin@gmail.com
/**
 * Bounded LRU for Pixi texture cache URLs.
 *
 * Pixi's ``Assets.load(url)`` caches the resolved texture in
 * ``Assets.cache`` *indefinitely*. When the annotation editor
 * navigates between assets, swapping the sprite's texture leaves the
 * previous texture pinned in CPU and GPU memory — a 4K RGBA8 image is
 * ~32 MB, and a session that walks 50 assets accumulates ~1.5 GB of
 * texture cache that is never released. That is the dominant
 * browser-tab RAM leak in the editor.
 *
 * The helper below is the small immutable LRU we drive from the
 * component: every successful ``Assets.load`` "touches" the url; if
 * the touch pushes the cache over ``capacity`` the helper returns the
 * stale URLs the caller should unload. The most-recently-touched
 * entry — i.e. the texture currently bound to the sprite — sits at
 * the *end* of the order and is therefore never an eviction
 * candidate, so swapping textures while in flight cannot blank the
 * canvas.
 *
 * The recommended capacity is 3:
 *   - 1 slot for the asset currently displayed,
 *   - 1 slot for the previous asset (instant ArrowLeft),
 *   - 1 slot for the next asset (instant ArrowRight after step back).
 *
 * Pure, immutable, deterministic — safe to call from any context and
 * trivial to test in isolation.
 */

export interface LruTouchResult {
  /** New MRU-ordered list; the touched URL is the last element. */
  readonly order: string[];
  /** URLs the caller should pass to ``Assets.unload`` (oldest first). */
  readonly evicted: string[];
}

/**
 * Promote ``url`` to most-recent. When the resulting order exceeds
 * ``capacity`` the oldest entries are dropped and returned in
 * ``evicted`` so the caller can release them. ``capacity`` must be
 * at least 1 — a capacity-zero cache would evict the texture we just
 * loaded and is never a valid configuration.
 */
export function touchTextureLru(
  order: ReadonlyArray<string>,
  url: string,
  capacity: number,
): LruTouchResult {
  if (capacity < 1) {
    throw new Error(`touchTextureLru: capacity must be >= 1 (got ${capacity})`);
  }
  // Move-to-end if already present, otherwise append.
  const promoted = order.filter((u) => u !== url);
  promoted.push(url);
  const evicted: string[] = [];
  while (promoted.length > capacity) {
    const stale = promoted.shift();
    if (stale !== undefined) evicted.push(stale);
  }
  return { order: promoted, evicted };
}

/**
 * Empty the cache (e.g. on full component unmount). Returns every URL
 * the caller must unload, in oldest-first order so logs read naturally.
 */
export function drainTextureLru(
  order: ReadonlyArray<string>,
): LruTouchResult {
  return { order: [], evicted: [...order] };
}

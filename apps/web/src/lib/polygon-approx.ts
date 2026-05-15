// Armin Mehri — mehri.armin@gmail.com
/**
 * Single source of truth for the "Polygon approximation points" slider
 * (0..100, stored in editor settings) → Douglas-Peucker epsilon_factor
 * conversion the model service understands.
 *
 *   slider   0 → epsilon 0.01    (very coarse, ~5-10 vertices)
 *   slider  50 → epsilon 0.001   (matches the legacy hardcoded default)
 *   slider 100 → epsilon 0.0001  (faithful trace, many vertices)
 *
 * The /sam/decode click path consumed this formula inline inside
 * ``canvas/tools/SamTool.ts`` already. The auto-annotate (text /
 * visual / batch) paths used to ignore the slider — the bug Armin
 * reported when setting 25 or 75 had no visible effect on the
 * resulting polygons. Extracting the helper lets the dialog re-use
 * the same conversion and keeps the two paths in sync.
 */
import { useEditorSettings } from "@/state/editorSettings";

/** Default slider position when no value is stored. Matches the
 * editor settings default; kept here as a constant so the helper has
 * a single safe fallback even when the store hasn't been hydrated. */
export const DEFAULT_POLYGON_APPROX_SLIDER = 55;

/**
 * Convert a 0..100 slider position to a Douglas-Peucker tolerance.
 * Pure — no side effects, safe to call from any context.
 */
export function epsilonFromPolygonSlider(slider: number): number {
  const clamped = Math.max(0, Math.min(100, slider));
  // Log-linear: 10**(-2 - 2*(slider/100)) = 0.01 * 0.01**(slider/100).
  return Math.pow(10, -2 - 2 * (clamped / 100));
}

/**
 * Read the user's current slider position from editor settings and
 * return the converted epsilon. Used by the click flow (SamTool) and
 * the auto-annotate dialog so both honour the same setting.
 */
export function currentPolygonEpsilonFactor(): number {
  return epsilonFromPolygonSlider(
    useEditorSettings.getState().polygonApproxPoints
      ?? DEFAULT_POLYGON_APPROX_SLIDER,
  );
}

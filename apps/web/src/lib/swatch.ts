/**
 * Deterministic class swatch palette — 12 perceptually-spaced OKLCH hues.
 * Used as a fallback when a class has no explicit color, and to keep the
 * UI palette consistent across surfaces.
 *
 * Consumed by:
 *   - apps/web/src/components/annotation/ClassesPanel.tsx
 *   - apps/web/src/pages/ClassesEditor.tsx
 */
export const SWATCH_VARS: readonly string[] = [
  "var(--swatch-0)",
  "var(--swatch-1)",
  "var(--swatch-2)",
  "var(--swatch-3)",
  "var(--swatch-4)",
  "var(--swatch-5)",
  "var(--swatch-6)",
  "var(--swatch-7)",
  "var(--swatch-8)",
  "var(--swatch-9)",
  "var(--swatch-10)",
  "var(--swatch-11)",
] as const;

export function swatchForIdx(idx: number): string {
  const i = ((idx % SWATCH_VARS.length) + SWATCH_VARS.length) % SWATCH_VARS.length;
  return SWATCH_VARS[i];
}

/**
 * Fixed hex palette used by class-create forms. The OKLCH `var(--swatch-*)`
 * tokens cannot round-trip through an `<input type="color">` (which expects
 * `#RRGGBB`), so we keep this hex palette in sync with the swatch order.
 *
 * 12 perceptually-distinct hues mirroring the order of the OKLCH set.
 */
export const PALETTE_HEX: readonly string[] = [
  "#EF4444", // red
  "#F59E0B", // amber
  "#EAB308", // yellow
  "#22C55E", // green
  "#10B981", // emerald
  "#06B6D4", // cyan
  "#3B82F6", // blue
  "#6366F1", // indigo
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#F43F5E", // rose
  "#64748B", // slate
] as const;

/**
 * Deterministic next hex color for a new class. Used when a user opens an
 * "add class" form so successive classes get visibly different colors instead
 * of all defaulting to the same purple. See /tmp/v21-audit.md bug F.
 */
export function nextHexForIdx(idx: number): string {
  const i = ((idx % PALETTE_HEX.length) + PALETTE_HEX.length) % PALETTE_HEX.length;
  return PALETTE_HEX[i];
}

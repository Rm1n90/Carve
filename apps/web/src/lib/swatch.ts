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

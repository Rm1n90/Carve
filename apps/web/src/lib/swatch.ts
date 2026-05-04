// Armin Mehri — mehri.armin@gmail.com
/**
 * Deterministic class swatch palette — perceptually-spaced OKLCH hues.
 * Used as a fallback when a class has no explicit color, and to keep the
 * UI palette consistent across surfaces.
 *
 * Consumed by:
 *   - apps/web/src/components/annotation/ClassesPanel.tsx
 *   - apps/web/src/components/annotation/AppearancePanel.tsx
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
 * Plan-19 — High-distinguishability hex palette.
 *
 * 30 colours chosen and ordered so adjacent indices land on different
 * hue families AND different lightness bands, making class chips much
 * easier to tell apart than the previous Tailwind-derived list (which
 * had six near-identical reds, four near-identical greens, etc.).
 *
 * Source: a curated extension of the well-known Sasha Trubetskoy
 * "22 distinguishable colours" set, plus 8 hand-picked deeper / lighter
 * variants to reach 30 without bunching into the same hue zones.
 *
 * Existing classes stored in the database keep their hex values — this
 * only changes what colour a *newly created* class lands on.
 */
export const PALETTE_HEX: readonly string[] = [
  "#E6194B", // red
  "#3CB44B", // green
  "#4363D8", // blue
  "#F58231", // orange
  "#911EB4", // purple
  "#FFE119", // yellow
  "#42D4F4", // cyan
  "#F032E6", // magenta
  "#BFEF45", // lime
  "#FABED4", // pink
  "#469990", // teal
  "#DCBEFF", // lavender
  "#9A6324", // brown
  "#800000", // maroon
  "#AAFFC3", // mint
  "#808000", // olive
  "#FFD8B1", // apricot
  "#000075", // navy
  "#A9A9A9", // grey
  "#FF6F61", // coral
  "#00B0FF", // sky
  "#FFB300", // amber
  "#C71585", // hot magenta
  "#00E676", // bright green
  "#6A1B9A", // deep purple
  "#1B5E20", // dark green
  "#1A237E", // indigo
  "#5D4037", // dark brown
  "#37474F", // blue grey
  "#EF6C00", // burnt orange
] as const;

/**
 * Deterministic next hex color for a new class. Used when a user opens an
 * "add class" form so successive classes get visibly different colors instead
 * of all defaulting to the same purple.
 */
export function nextHexForIdx(idx: number): string {
  const i = ((idx % PALETTE_HEX.length) + PALETTE_HEX.length) % PALETTE_HEX.length;
  return PALETTE_HEX[i];
}

/**
 * Procedurally generate a hex color from an index using golden-ratio hue
 * stepping in HSL space. Used as a fallback when the curated PALETTE_HEX
 * is exhausted (>30 classes).
 */
export function hslHexForIdx(idx: number): string {
  const golden = 0.61803398875;
  const hue = ((idx * golden) % 1) * 360;
  const sat = 65;
  const light = 50 + ((idx * 7) % 20) - 10;
  return hslToHex(hue, sat, light);
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Return the next unused color given the already-used colors in a project.
 * Walks PALETTE_HEX in order; if all 30 curated colors are taken, falls
 * through to procedural HSL hashing so the next class still gets a
 * deterministic, distinct hue. Case-insensitive comparison.
 */
export function nextUnusedColor(usedColors: readonly string[]): string {
  const used = new Set(
    usedColors.map((c) => (c ?? "").toLowerCase()).filter(Boolean),
  );
  for (const c of PALETTE_HEX) {
    if (!used.has(c.toLowerCase())) return c;
  }
  for (let attempt = 0; attempt < 256; attempt++) {
    const candidate = hslHexForIdx(usedColors.length + attempt);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return hslHexForIdx(usedColors.length + Math.floor(Math.random() * 1000));
}

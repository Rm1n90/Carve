/**
 * Bundle budget guard. Asserts that the production entry chunk stays
 * below the 250 kB gzipped budget set in plan 09 phase 5 task 7.
 *
 * The test reads the existing `apps/web/dist/assets/index-*.js` artifact
 * (Vite's entry chunk filename pattern) and gzip-compresses it in-process.
 * If `dist` is missing it spawns `npm run build` once.
 *
 * Skip with `STAT_BUNDLE=0` (e.g. on slow CI or local dev runs that
 * don't need to re-validate the bundle on every test run).
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const BUDGET_BYTES_GZIPPED = 250 * 1024;
const WEB_ROOT = path.resolve(__dirname, "..");
const DIST_ASSETS = path.join(WEB_ROOT, "dist", "assets");

function ensureDist(): void {
  if (existsSync(DIST_ASSETS)) return;
  // Build is expensive; only run when artifact is missing.
  execSync("npm run build", { cwd: WEB_ROOT, stdio: "inherit" });
}

function findEntryChunks(): string[] {
  const files = readdirSync(DIST_ASSETS);
  // Vite emits the entry chunk as `index-<hash>.js`. Other chunks have
  // their manualChunks name as prefix (e.g. `pixi-<hash>.js`).
  return files.filter((f) => /^index-[A-Za-z0-9_-]+\.js$/.test(f));
}

const skip = process.env.STAT_BUNDLE === "0";

describe.skipIf(skip)("bundle budget", () => {
  it("entry chunk gzipped size is below 250 kB", () => {
    ensureDist();
    const entries = findEntryChunks();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const full = path.join(DIST_ASSETS, entry);
      const raw = readFileSync(full);
      const gzipped = gzipSync(raw);
      // Helpful breadcrumb in the test output when the budget regresses.
      // eslint-disable-next-line no-console
      console.log(
        `[bundle-budget] ${entry}: raw=${raw.length}B gzipped=${gzipped.length}B`,
      );
      expect(
        gzipped.length,
        `${entry} gzipped ${gzipped.length}B exceeds budget ${BUDGET_BYTES_GZIPPED}B`,
      ).toBeLessThan(BUDGET_BYTES_GZIPPED);
    }
  });
});

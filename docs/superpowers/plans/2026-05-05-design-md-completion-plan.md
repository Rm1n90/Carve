# DESIGN.md Completion Sweep — Plan

## Context

The DESIGN.md application has six commits already merged on
`phase9/design-md-button-signature`:

1. `4b580b1` — primary Button hover signature
2. `b901b9f` — UI primitives (Input/Select/Dialog/Card/Badge/IconButton) + canonical tokens
3. `e490747` — glass utilities → solid surfaces; Confirm/Popover/Tooltip/Toaster
4. `0d6bdbe` — Fraunces serif retired; off-palette hardcoded hexes deleted
5. `24f7a9e` — settings overview headlines weight 300
6. `a2b0e6e` — single CSS rule retires ALL-CAPS kickers

Working tree clean on the design-md branch, web container live.

This plan covers the remaining DESIGN.md drift across the codebase.
Each track is independent and dispatchable to its own subagent.

## Tracks

### Track A — Inline button standardisation

**Goal:** Every `<button>` callsite that bypasses the `Button`/`IconButton`
primitive should either migrate to the primitive or carry the DESIGN.md
hover signature inline.

**Scope (16 files):**
- `apps/web/src/components/nav/TopBar.tsx` — user menu button, breadcrumb pills
- `apps/web/src/components/nav/LeftNav.tsx` — nav buttons, project switcher
- `apps/web/src/components/projects/ProjectsToolbar.tsx` — search, view toggle, filter pills
- `apps/web/src/components/tasks/TasksToolbar.tsx` — search, view toggle
- `apps/web/src/pages/AssetGrid.tsx` — filter pills, action buttons
- `apps/web/src/pages/DatasetsPage.tsx` — toolbar action buttons
- `apps/web/src/pages/ClassesEditor.tsx` — header actions
- `apps/web/src/pages/StatsPanel.tsx` — date filter, action buttons
- `apps/web/src/pages/ImportDialog.tsx` — confirm/cancel buttons (if not Button primitive)
- `apps/web/src/components/annotation/EditorToolbar.tsx` — every toolbar button
- `apps/web/src/components/annotation/ReviewPanel.tsx` — accept/reject buttons
- `apps/web/src/components/annotation/SamTrackPanel.tsx` — track controls
- `apps/web/src/components/annotation/ClassesPanel.tsx` — class manage actions
- `apps/web/src/components/annotation/ObjectsPanel.tsx` — object actions
- `apps/web/src/components/annotation/AppearancePanel.tsx` — appearance controls
- `apps/web/src/components/annotation/AnnotationContextMenu.tsx` — context menu items

**Standard:** DESIGN.md §4 — primary buttons get cyan fill swap + 2px white
border + 2px PS-blue ring + 1.05× lift + 180ms ease. Pill 999px radius for
primary actions, full hover treatment. Tertiary inline buttons can stay as
bg-hover transitions but should still have 180ms ease and the right radius
tier.

**Acceptance:** No raw `<button>` with `bg-[var(--accent)]` that lacks
`hover:scale-[1.05]` and the white-border + blue-ring shadow. No buttons
with `transition-colors duration-150` (DESIGN.md is 180ms ease). Uses
`rounded-[var(--radius-pill)]` or `rounded-[var(--radius-6)]` instead of
arbitrary values.

### Track B — DropdownMenu surface alignment

**Goal:** Every `DropdownMenu.Content` callsite uses solid surface, the
correct radius tier (6px for compact menus), and `--shadow-card`. The
glass redefinition makes them solid already, but radius and padding
patterns drift across files.

**Scope (7 files):**
- `apps/web/src/components/nav/TopBar.tsx` — user menu
- `apps/web/src/components/nav/LeftNav.tsx` — workspace switcher
- `apps/web/src/components/annotation/EditorToolbar.tsx` — multiple menus
- `apps/web/src/components/annotation/ClassesPanel.tsx` — class action menus
- `apps/web/src/pages/ProjectDetailPage.tsx` — task action menu
- `apps/web/src/pages/SettingsPages.tsx` — workspace action menu
- `apps/web/src/components/annotation/FilterBuilderDialog.tsx` — filter menu

**Standard:** `min-w-[NNNpx] rounded-[var(--radius-6)] bg-[var(--bg-elev)]
border border-[var(--border-subtle)] shadow-[var(--shadow-card)] p-1` —
matches the new `Popover` / `Select.Content` baseline.

**Acceptance:** No DropdownMenu still references `glass-surface-strong`.
All use the canonical solid-surface pattern.

### Track C — Sans-serif uppercase residuals

**Goal:** Convert remaining sans-serif `uppercase` callsites to sentence
case unless they are genuine data-table column headers (which DESIGN.md
tolerates as a structural exception).

**Scope (4 files):**
- `apps/web/src/pages/ClassesEditor.tsx:212` — table column header (KEEP)
- `apps/web/src/pages/ClassesEditor.tsx:670` — section label (CHANGE)
- `apps/web/src/components/annotation/KeyboardCheatSheet.tsx:185` — section header (CHANGE)
- `apps/web/src/pages/AssetGrid.tsx:462` — filter strip label (CHANGE)
- `apps/web/src/pages/DatasetsPage.tsx:248` — table column header (KEEP)

**Standard:** Drop `uppercase` and `tracking-[0.XXem]`; use `tracking-tight`
or no tracking. Keep only on data-table column headers.

### Track D — Section title weight audit

**Goal:** DESIGN.md §3 weight gradient (300 display → 400 body → 500 captions
→ 700 buttons). Section titles at 16–18px should be weight 600 (UI Heading
Small per §3 table) — not `font-medium` (500), which collapses with body.

**Scope:** Audit-and-fix pass across pages — search for
`text-\[1[6-8]px\][^"]*font-medium` and convert to `font-semibold` where
the element is a section heading, or `font-light` where it is display-tier.

**Acceptance:** Section titles 16–18px are `font-semibold`; display-tier
22px+ are `font-light` (already mostly done by `font-editorial`
redefinition).

### Track E — Section background gradients

**Goal:** DESIGN.md §2 declared two section gradients
(`--gradient-section-light`, `--gradient-section-dark`). Tokens are
defined but no page uses them yet. Add the dark gradient to hero zones
so the page rhythm starts to alternate per DESIGN.md §1.

**Scope (2 files):**
- `apps/web/src/pages/ProjectDetailPage.tsx` — hero zone
- `apps/web/src/pages/AnnotateAssetPage.tsx` — top toolbar strip

**Standard:** `background: var(--gradient-section-dark)` on hero panels in
dark theme; respect light theme via the existing `[data-theme="light"]`
overrides where needed.

## Build order

1. **Track A and Track B in parallel** — independent files, no shared
   primitives modified.
2. **Track C** — quick spot-fix pass; can run anytime.
3. **Track D** — careful audit; runs after A/B since it touches the same
   files.
4. **Track E** — purely additive, runs last.

## Quality gates

- After each track: `cd apps/web && npx tsc --noEmit` must pass clean.
- After all tracks: `docker compose build web && docker compose up -d
  --force-recreate --no-deps web`. Verify in served bundle:
  - Zero `glass-surface-strong` references in DropdownMenu callsites
  - `hover:scale-[1.05]` and `hover:shadow-[0_0_0_2px` present on all
    primary inline buttons
  - `var(--gradient-section-dark)` present in CSS for hero zones

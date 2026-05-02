# Phase 9 — UX Refinements (v3.12 feedback)

Branch: `phase9/ux-refinement-v3.12`. Source: post-v3.12 hands-on user feedback.

## Tracks

### A. Right-click context menu (`AnnotationContextMenu.tsx`)
- A1. Remove the "Change color…" item entirely.
- A2. Replace click-triggered "Pick class" submenu with hover-triggered submenu that pre-renders the class list.
- A3. Clamp `left`/`top` so the floating menu (and any submenu) stay inside the viewport — measure after mount, then shift if `right > innerWidth` or `bottom > innerHeight`.

### B. Canvas readability (`AnnotationCanvas.tsx`)
- B1. Increase class label font size in bbox / polygon / mask labels (and add background pill so it stays readable on busy frames).
- B2. Increase polygon vertex + bbox handle hit/render size so they are easier to grab; keep aspect on zoom.

### C. Settings wiring (`EditorSettingsDialog.tsx`, settings/workspace pages)
- C1. Audit each control on Workspace settings + Player settings pages. Wire any placeholder toggles to a real store (`editorPrefs` zustand slice + persist) and apply them in canvas/player. Remove controls that have no meaningful target.

### D. Editor toolbar (`EditorToolbar.tsx`)
- D1. Decide "Auto apply" — if it controls brush/SAM auto-commit, label it explicitly and wire; otherwise remove.
- D2. Move Shortcuts + Info buttons next to the Settings (gear) icon.
- D3. Restyle "Auto annotate" button to match "Predict" (purple gradient surface).

### E. Projects page (`ProjectsPage.tsx` / `ProjectsToolbar.tsx`)
- E1. Move the "Recent" strip into a tab alongside All / Owned / Shared / Pinned.

### F. Dropdown styling (global)
- F1. Provide a single `<Dropdown>` / `<Select>` glass-surface variant in `components/ui/`, then migrate bare `<select>` and ad-hoc dropdown menus.

### G. Task creation + archive
- G1. Add `due_date` (or scheduled date) field to TaskCreateDialog form; persist via existing tasks API (add migration if column missing).
- G2. Add a real "Archive task" action in the kebab menu (set `tasks.archived_at`, hide from default list, surface under Archived tab). Include unarchive.

## Execution order

1. A (right-click) — small, isolated, user-ranked first.
2. D (toolbar) — visible, isolated.
3. B (canvas readability) — small constants change.
4. E (projects tab) — single-page change.
5. F (dropdown styling) — design-system component, migrate top offenders.
6. C (settings wiring) — broader audit; do after F so Dropdown is available.
7. G (task date + archive) — backend migration + form + kebab action.

Each track ends with a focused commit; merge as one phase9 release once all green.

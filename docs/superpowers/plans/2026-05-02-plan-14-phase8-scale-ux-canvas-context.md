# Plan 14 — Phase 8: Scale UX + Canvas Context Menu + Class Palette

> **For agentic workers:** REQUIRED SUB-SKILLS: superpowers:subagent-driven-development, frontend-design.

**Goal:** the editor and navigation surfaces should stay fast and intuitive when a workspace has hundreds of projects, dozens of tasks each, thousands of assets, and **70+ classes**. Specifically:

1. **Project & task navigation at scale** — search, sort, virtualisation, recent/pinned, sticky filters, breadcrumbs.
2. **Class palette at scale** — number shortcuts (`1..9`) only address the first 9 classes today; with 70+ classes the user needs a Cmd-K-style searchable palette, fuzzy match, recent/pinned, and per-annotation reassign.
3. **Canvas right-click context menu** — CVAT-quality (or better): change class, lock, duplicate, send to front/back, copy color, delete, create-from-template, paste-from-clipboard.
4. **Multi-select & bulk operations** — shift-click and drag-rectangle on canvas; multi-select on the asset strip; bulk reassign / accept / reject / delete.
5. **Performance** — server-side pagination & virtualisation for asset lists, debounced search, lazy thumbnails everywhere, prefetched neighbours.

## Series context

- ✅ Plan 09 + 09b — Phase 5 review/QA, active learning, perf, editor polish
- ✅ Plan 11 + 12 — Phase 6 SAM 3.1 native end-to-end
- ✅ Plan 13 — Phase 7 workspace polish, dataset versioning, search, quality, brand
- **Plan 14 — Phase 8** ← *this plan*

---

## Track A — Navigation at scale

### Task 1: Projects index page — search + sort + sticky filters + virtualisation

**Files:**
- modify `apps/web/src/pages/ProjectsPage.tsx` (the existing projects index)
- new `apps/web/src/components/projects/ProjectsToolbar.tsx`
- new `apps/web/src/components/projects/ProjectCard.tsx` (extracted)
- new `apps/web/tests/projects-toolbar.test.tsx`

**Spec:**
- Sticky toolbar at the top: search input (debounce 200ms), sort dropdown (Name asc/desc, Updated desc, Created desc), filter chips (All / Owned / Shared / Pinned), view toggle (Cards / Compact list).
- Pin/unpin a project with a star button on the card (persisted via the existing user preferences slice if any, otherwise localStorage keyed by user id).
- Recent projects (last 5 visited) appear above the main grid when not searching/filtering.
- Empty states: "No projects yet — create your first one." on a brand-new account; "No matches for `<query>`" on filtered.
- Virtualisation: when >40 projects, switch to `@tanstack/react-virtual` grid (already a project dep). Below 40, render plain.
- Compact list view: dense table with name / role chip / asset count / last activity / actions kebab.

**Tests:**
- Search narrows the list; clearing restores it.
- Sort by Name / Updated changes the order.
- Pin star toggles + persists; pinned filter shows only pinned.

### Task 2: Project detail — task list scale + breadcrumbs + filters

**Files:**
- modify `apps/web/src/pages/ProjectDetailPage.tsx`
- new `apps/web/src/components/tasks/TasksToolbar.tsx`
- new `apps/web/src/components/tasks/TaskRow.tsx` (extracted)
- new `apps/web/tests/tasks-toolbar.test.tsx`

**Spec:**
- Breadcrumbs at the top of every project + task page: `Workspace › <Project> › <Task> › <Asset>`. Each segment clickable; current segment is bold and not a link.
- Tasks tab gets a sticky toolbar: search + status filter (Active / Archived / All) + sort (Updated / Name) + "New task" button.
- Task row shows: name, asset count, % annotated, % accepted, % rejected (uses existing review status), last activity, kebab menu (existing).
- Empty state for new projects.

**Tests:** task search narrows; status filter narrows; breadcrumb renders + each segment links.

### Task 3: Asset strip & grid — multi-select + jump-to-N + range select

**Files:**
- modify `apps/web/src/components/annotation/AssetThumbnailStrip.tsx`
- new `apps/web/tests/asset-strip-multi-select.test.tsx`

**Spec:**
- Shift-click selects a range. Cmd/Ctrl-click toggles single. Esc clears.
- Multi-select bar appears at the bottom when >0 selected: counter + "Delete" + "Move to task..." + "Tag…" + clear.
- `g` key jumps to a specific position: opens an inline "Go to asset N / TOTAL" prompt.
- Existing keyboard nav (arrow keys, [/]/, etc.) preserved.

**Tests:** shift-click range, Cmd-click toggle, jump-to prompt.

---

## Track B — Class palette at scale (CRITICAL for 70+ classes)

### Task 4: Class command palette — Cmd-/ to search, fuzzy match, recents, pinned

**Files:**
- new or upgrade `apps/web/src/components/annotation/ClassCommandPalette.tsx` (look for any existing one — there's a stub in `AnnotationCanvas.tsx` opened by `/`; productize it)
- new `apps/web/src/state/classRecents.ts` — zustand slice for recent + pinned class ids per project, persisted to localStorage
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx` — `/` opens the palette in "set active class" mode; `R` opens it in "reassign selected" mode when an annotation is selected
- modify `apps/web/src/components/annotation/ClassesPanel.tsx` (right rail) — pin/unpin star + "show all" expander when >12 classes
- new `apps/web/tests/class-command-palette.test.tsx`

**Spec:**
- Triggers: `/` (set active), `R` (reassign selected), `Cmd-Shift-C` (set active, alt key for power users).
- The palette is a Radix Dialog with:
  - Search input at top (autofocus, fuzzy matching against class name; case-insensitive substring, then optional `cmdk`-style fuzzy if it's already a project dep — verify; otherwise ship substring + simple ranking).
  - Tabs above the list: **Pinned** (default when there are pinned items), **Recent** (last 8), **All**.
  - Each row: color dot (existing class color) + name + index hint (`1`, `2`, … `9` for first 9; nothing for the rest) + pin star (right-aligned, click to pin/unpin).
  - Footer: keyboard hints — `↑↓ navigate`, `Enter pick`, `⌘P pin`, `Esc close`.
- Behavior:
  - `set active` mode: picking a row sets `activeClassId` and closes.
  - `reassign selected` mode: title says "Reassign N selected annotations to…"; picking a row updates each draft's `classId`. Marks them dirty.
  - Number keys `1..9` still work as a SHORTCUT outside the palette but only address the first 9 classes (existing behavior). The palette is the canonical path beyond 9.

**Recents/Pinned slice (`classRecents.ts`):**
```ts
type ClassRecentsState = {
  pinnedByProject: Record<string, string[]>;  // project_id -> class_ids
  recentByProject: Record<string, string[]>;
  pin: (projectId: string, classId: string) => void;
  unpin: (projectId: string, classId: string) => void;
  recordUse: (projectId: string, classId: string) => void;  // pushes to front, max 8
};
```
Persist via zustand `persist` middleware. Cap recent at 8.

**Tests:**
- `/` opens, type "ca", `Car` is at top.
- Pin + repaint with the pinned tab default.
- Selected annotation + `R` opens in reassign mode; picking flips its classId.

### Task 5: Quick class assignment from canvas — type to filter, no palette

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx`
- new `apps/web/tests/quick-class-assign.test.tsx`

**Spec:**
- When an annotation is selected and the user starts typing letters (not numbers, not modifiers), open the palette in reassign mode pre-filled with the typed letter. Reduces friction past the explicit `R` shortcut.
- Cancellable with Esc.

**Tests:** select an annotation, press `c`, palette opens with `c` in the search box and `Car` highlighted.

---

## Track C — Canvas right-click context menu (CVAT-quality)

### Task 6: Annotation context menu

**Files:**
- new `apps/web/src/components/annotation/AnnotationContextMenu.tsx`
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx` — wire pointerdown right-click hit-testing → open the menu at the cursor.
- modify `apps/web/src/state/annotations.ts` — add `lockedIds: Set<string>` and helpers; add `duplicate(id)`.
- new `apps/web/tests/annotation-context-menu.test.tsx`

**Spec:**

Right-click on an annotation opens a Radix DropdownMenu/ContextMenu at the cursor with:

- **Change class…** (`R`) — opens the palette in reassign mode.
- **Change color…** — submenu with the 14 stock colors + "From class color (default)".
- **Lock / Unlock** — locked annotations cannot be moved/edited but stay visible. (When the cursor is over a locked annotation, the cursor shows "lock" and clicks no-op.)
- **Send to front** (`Cmd-Shift-]`) / **Bring forward** (`Cmd-]`) / **Send backward** (`Cmd-[`) / **Send to back** (`Cmd-Shift-[`) — these already have keyboard shortcuts; surface them in the menu.
- **Duplicate** (`Cmd-D`) — clones the annotation 16px right + 16px down, same class, fresh tempId.
- **Copy** (`Cmd-C`) / **Paste** (`Cmd-V`) — internal clipboard (zustand slice). Paste at last cursor position.
- **Delete** (`Backspace` / `Delete`) — existing behavior.
- **Reveal in panel** — scrolls the right-rail Objects panel to this annotation and selects it.

Right-click on empty canvas opens a different menu:
- **Paste annotation** (Cmd-V) — if clipboard has anything.
- **Deselect all** (Esc).
- **Fit to screen** / **Reset zoom**.

**Tests:** right-click on a bbox → menu opens with "Change class". Click "Duplicate" → 2nd annotation appears 16px offset. Right-click empty canvas → different menu set.

---

## Track D — Multi-select & bulk operations

### Task 7: Canvas multi-select + bulk class reassign

**Files:**
- modify `apps/web/src/components/annotation/AnnotationCanvas.tsx` — drag-rectangle in cursor mode selects intersecting annotations.
- modify `apps/web/src/state/annotations.ts` — already has `selectedIds`; add `setActiveClassForSelected(classId)` action.
- modify `apps/web/src/components/annotation/ClassCommandPalette.tsx` — uses `setActiveClassForSelected` in reassign mode.
- new `apps/web/tests/canvas-multi-select.test.tsx`

**Spec:**
- In cursor tool, drag with `LMB` over empty space → marquee selection rectangle. Annotations whose bbox intersects the rectangle become selected.
- `Cmd-A` selects all annotations on the current frame.
- Multi-select indicator: status bar at the bottom of the canvas shows `N selected`.
- `R` while N>1 selected opens palette in reassign mode → applies to all.
- `Backspace` deletes all.

**Tests:**
- Marquee selects 3 of 5 annotations.
- Reassign-multi via palette flips all 3 classIds.

---

## Track E — Performance & polish

### Task 8: Asset list performance — server-side filter cursor + smart prefetch

**Files:**
- modify `apps/web/src/components/annotation/AssetThumbnailStrip.tsx`
- modify `apps/web/src/api/assets.ts` (add infinite-query helpers if missing — Plan 09b Task 8 added basic virtualisation; this extends it)
- new `apps/web/tests/asset-strip-prefetch.test.tsx`

**Spec:**
- When the user navigates to asset N, prefetch N+1, N+2 (existing pattern; verify it covers the just-fetched page).
- When the strip is filtered (saved view), the API call carries the saved-view filter so virtualisation works against the filtered set.
- 10k-asset task scrolls without paint stutter (verify via the existing virtualised test).

### Task 9: Editor breadcrumbs + sticky tool affordances

**Files:**
- modify `apps/web/src/components/nav/TopBar.tsx` — render breadcrumbs in the editor route.
- modify `apps/web/src/components/annotation/EditorToolbar.tsx` — keep the toolbar sticky on scroll; collapse less-used buttons into an overflow menu when the viewport is narrow.

**Spec:**
- Breadcrumbs in editor: `Workspace › Project › Task › Asset N/M`.
- Toolbar at <1280px collapses zoom/visibility/cheat-sheet/etc into a `…` overflow popover.

---

## Track F — UI/UX polish (frontend-design)

### Task 10: Empty states, loading skeletons, micro-interactions

**Files:**
- new `apps/web/src/components/ui/EmptyState.tsx` (composable empty-state with icon + title + description + cta)
- modify the empty branches in `ProjectsPage`, `ProjectDetailPage`, `DatasetsPage`, audit log
- modify the loading branches to render skeletons (use `<Skeleton>` from Plan 09 Task 7)

**Spec — guided by superpowers:frontend-design:**
- Editorial / refined aesthetic. Restraint, generous whitespace, intentional typography pairing (Geist + Fraunces — already loaded).
- Use the project's existing oklch tokens; do not introduce new ad-hoc colors.
- Empty states feel encouraging, not error-y. Typed line + small illustrative icon.
- Skeletons match the layout of the loaded content (same row heights, same padding).

---

## Self-Review Checklist

- [ ] Projects index works smoothly with 200+ projects.
- [ ] Task list works with 100+ tasks per project.
- [ ] Asset strip handles 10k assets via virtualisation.
- [ ] Class palette opens with `/`, fuzzy-searches across 70+ classes, picks set active class.
- [ ] `R` while annotation selected opens palette in reassign mode; multi-select reassign works.
- [ ] Right-click on annotation opens context menu with all 9+ items.
- [ ] Right-click on empty canvas opens a different menu.
- [ ] Marquee selection in cursor tool works.
- [ ] Pinned + Recent classes persist in localStorage per project.
- [ ] Breadcrumbs in editor route render and link.
- [ ] No regressions in existing test suites.

## Tag

`v3.12.0 — Phase 8: scale UX, class palette, canvas context menu, multi-select`

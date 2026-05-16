# User-customisable digit shortcuts for classes

**Date:** 2026-05-16
**Author:** Armin Mehri ([mehri.armin@gmail.com](mailto:mehri.armin@gmail.com))
**Status:** Draft

## Problem

Projects with many classes (Armin reported 80+) make digit shortcuts useless past the ninth one. Today the right-rail Classes panel maps digits 1–9 to the first nine classes by panel order (`ClassesPanel.tsx:917-919` reads `classes[n-1]`) and the AnnotationCanvas's SAM-commit-with-digit path reads `c.idx === digit - 1` (`AnnotationCanvas.tsx:3729-3730`). Both are static — there is no way for an annotator currently working with classes 56 and 20 to put them on keys 8 and 4. Productivity tanks because the user must either reach for the mouse or memorise creation-order indices that are buried below the fold.

A separate "Pinned" concept (`state/classRecents.ts`) is independent of digit shortcuts. We are not folding that in — pin order remains a view-only convenience.

## Goal

Let each user, per project, bind digits 1–9 to any 9 of the project's classes. Assignment is one keystroke (`Shift + digit`) and visible in the panel so the user can audit at a glance. Defaults preserve today's behaviour: digits 1–9 seed to the first nine classes by `class.idx` so existing users notice no regression.

## Non-Goals

- Drag-to-reorder hotkey slots / dedicated settings page / right-click menus
- Sharing bindings between users ("team defaults")
- Binding to keys other than 1–9 (no `0`, `-`, `=`, function keys)
- Migrating bindings across projects
- A "view active bindings" overlay / dialog — the badges in the rail are the audit surface

## Design

### 1. Data model

New table `class_keybindings`:

| Column        | Type        | Constraint                                            |
| ------------- | ----------- | ----------------------------------------------------- |
| `user_id`     | UUID        | NOT NULL, FK `users(id)`                              |
| `project_id`  | UUID        | NOT NULL, FK `projects(id) ON DELETE CASCADE`         |
| `digit`       | SMALLINT    | NOT NULL, CHECK (digit BETWEEN 1 AND 9)               |
| `class_id`    | UUID        | NOT NULL, FK `classes(id) ON DELETE CASCADE`          |
| `created_at`  | TIMESTAMPTZ | NOT NULL, DEFAULT NOW()                               |
| `updated_at`  | TIMESTAMPTZ | NOT NULL, DEFAULT NOW()                               |

```sql
PRIMARY KEY (user_id, project_id, digit)
UNIQUE      (user_id, project_id, class_id)
```

The `UNIQUE (user_id, project_id, class_id)` constraint enforces **one digit per class**: re-binding a class to a different digit moves the row instead of creating a duplicate. Without it, the same class could show two `[N]` badges, which is confusing.

`ON DELETE CASCADE` on both `project_id` and `class_id` keeps the table consistent without application-level cleanup. The `users(id)` FK does NOT cascade — soft deletes of users leave their bindings untouched (consistent with `class_recents`, `weight_project_defaults` today).

**Migration:** standard Alembic forward / down migration under `apps/api/migrations/`. No data backfill — the seeding logic lives in the read path.

### 2. API

Three endpoints, mounted under the existing `projects` router:

| Method   | Path                                                | Purpose                                                    |
| -------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `GET`    | `/projects/{pid}/class-keybindings`                 | Read effective bindings (stored ∪ computed seed)           |
| `PUT`    | `/projects/{pid}/class-keybindings/{digit}`         | Bind / move that digit (body `{ class_id: UUID }`)         |
| `DELETE` | `/projects/{pid}/class-keybindings/{digit}`         | Clear that digit                                           |

**GET response shape:**

```json
{
  "bindings": [
    { "digit": 1, "class_id": "...", "source": "stored" }
  ]
}
```

`source` is one of `"stored"` (row exists in the table) or `"seed"` (computed from `class.idx ASC LIMIT 9`, no row yet). The first explicit `PUT` materialises the remaining seed rows in the same transaction, so that if the user later inserts a new class with a lower `idx`, their old `1=Bus` binding does not silently slide to the new class.

**PUT body:**

```json
{ "class_id": "uuid-of-target-class" }
```

Server validation:
- `digit` must be 1..9 → 422 `invalid_digit`
- `class_id` must belong to `project_id` → 422 `class_not_in_project`
- If `(user_id, project_id, class_id)` already exists at a different digit, that row is deleted in the same transaction (move-not-duplicate) and the new row inserted.

**DELETE:** idempotent; 204 even if no row existed.

**Permissions:** all three endpoints require `user_can_view_project(user, project)` (read-only role is fine — bindings are personal).

### 3. Frontend store

New TanStack query:

```ts
useQuery({
  queryKey: ["class-keybindings", projectId],
  queryFn: () => api.get(`/projects/${projectId}/class-keybindings`),
  staleTime: 60_000,
});
```

A pure helper composes the consumer-facing map:

```ts
// apps/web/src/lib/class-keybindings.ts
export function effectiveBindings(
  stored: BindingRow[],
  classes: ClassRow[],
): Record<number, string> {  // digit → classId
  // 1. Stored bindings take precedence.
  // 2. Empty digits fall back to classes sorted by idx ASC, skipping
  //    classes that are already bound by a stored row (no duplicates).
}
```

A single PUT mutation handles add/move:

```ts
const bind = useMutation({
  mutationFn: ({ digit, classId }) =>
    api.put(`/projects/${projectId}/class-keybindings/${digit}`,
            { class_id: classId }),
  onMutate: optimisticUpdateCache,
  onSettled: () => qc.invalidateQueries(["class-keybindings", projectId]),
});
```

DELETE follows the same pattern. Optimistic update — the badge appears / moves instantly; rollback on error with a toast.

### 4. ClassesPanel UI

Each class row that is currently bound to a digit gains a `<Kbd>` badge on the right:

```
Right rail (Classes panel):

  ▸ Bus       [1]     <-- bound
  ▸ Car       [2]
    Person
    Tree
  ▸ Truck     [3]
    ...
    (74 more)
```

Visual notes:

- Reuse the existing `<Kbd>` primitive used by the keyboard cheat sheet. No new styling token.
- Badge is non-interactive — purely an indicator. All assignment goes through the keyboard.
- Render the badge in the existing class-row right-side gutter alongside the swatch and any selection / hidden indicators. No new layout primitives.
- Badge appears under both expanded and collapsed list densities.

### 5. Keyboard wiring

A single window-level keydown handler — hoisted into `AnnotateAssetPage` (or the existing ClassesPanel listener at `ClassesPanel.tsx:913-925` is upgraded). The handler is the **only** consumer that translates digit presses into class IDs; both `ClassesPanel` and `AnnotationCanvas.tsx:3725-3734` (the SAM commit-with-digit path) read from `effectiveBindings`.

Pseudo-code:

```ts
function onKeydown(e: KeyboardEvent) {
  if (isEditableTarget(e.target)) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const digit = parseInt(e.key, 10);

  // Shift+digit → bind / unbind
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const activeId = useTool.getState().activeClassId;
    const activeClass = activeId
      ? classes.find(c => c.id === activeId) : null;
    if (!activeClass) {
      showToast("Select a class first to bind a hotkey.",
                { variant: "info" });
      return;
    }
    e.preventDefault();
    const current = effective[digit];
    if (current === activeClass.id) {
      // Pressing Shift+N again on the same class clears it.
      deleteBind.mutate({ digit });
      showToast(`Digit ${digit} cleared`, { variant: "info" });
    } else {
      bind.mutate({ digit, classId: activeClass.id });
      showToast(`Digit ${digit} → ${activeClass.name}`,
                { variant: "success" });
    }
    return;
  }

  // Any other modifier → not our chord, let other handlers see it.
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

  // Plain digit → activate the bound class.
  const classId = effective[digit];
  if (classId) {
    e.preventDefault();
    setActiveClassId(classId);
  }
}
```

`ClassesPanel.tsx:917-919` is removed (its logic is subsumed). `AnnotationCanvas.tsx:3725-3734` keeps its SAM-commit semantics but looks up `effective[digit]` instead of `classes.find(c => c.idx === idx)`.

### 6. Default seeding + one-time hint

Server-side seeding (described in §2 GET) keeps existing users on their familiar 1–9 = first-nine-classes-by-idx mapping. They notice no regression.

One-time hint via the toast bus: when the keybindings query first resolves AND `localStorage["carve.class-keybindings.hint-seen-v1"]` is falsy, show an `info` toast:

> Tip: select a class and press Shift+digit to assign that key.

Dismiss = set localStorage key. Per-browser, per-user — a hint, not a setting.

### 7. Edge cases

| Scenario                                                | Behaviour                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Class deleted while bound                               | `ON DELETE CASCADE` removes the row server-side. The classes query already invalidates on class delete; the bindings query auto-refetches via shared cache key invalidation. |
| Project has fewer than 9 classes                        | Some digits have no seed and no stored row. Plain digit press = no-op; no toast.                                  |
| `Shift+digit` with no active class                      | Info toast prompts the user to pick a class first. No mutation fires.                                              |
| `Shift+digit` re-pressed on the same class for the same digit | Treated as **unbind**. Toast `Digit N cleared`. Inverse of the bind operation.                                     |
| Same class already bound to digit X, user presses Shift+Y on it | Server moves the row (UNIQUE constraint behaviour). Frontend re-renders: badge moves from X to Y in one tick.      |
| Two browser tabs editing simultaneously                 | Last write wins. React Query refetch on focus + the post-mutation invalidate converge both tabs.                   |
| Server unreachable mid-mutation                         | Optimistic update applies, rollback on error, toast `Couldn't save hotkey — check connection`. Tool state stays clean. |

### 8. Testing

**Backend (pytest, under `apps/api/tests/projects/`):**

| Test                                                  | Covers                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| `test_get_empty_returns_seeded_first_nine`            | GET on no rows + ≥9 classes → server-composed seed |
| `test_get_empty_with_few_classes`                     | GET on no rows + 3 classes → 3 seed rows, no rest   |
| `test_put_creates_binding`                            | PUT new binding persists                            |
| `test_put_moves_existing_class_binding`               | PUT a class already on digit X → row at X deleted, new row at Y |
| `test_put_overwrites_existing_digit`                  | PUT replacing the class on a digit overwrites cleanly |
| `test_delete_clears`                                  | DELETE removes the row                              |
| `test_delete_idempotent`                              | DELETE on empty digit → 204                         |
| `test_put_invalid_digit_422`                          | PUT digit=10 / 0 / "x" → 422 `invalid_digit`        |
| `test_put_class_outside_project_422`                  | PUT with class_id from another project → 422        |
| `test_class_deletion_cascades`                        | Deleting the bound class removes the binding row    |
| `test_project_deletion_cascades`                      | Deleting the project removes all bindings           |
| `test_seed_materialisation_on_first_put`              | First PUT writes the new value AND materialises the rest of the seed for stable bindings |

**Frontend (vitest):**

| Test                                                  | Covers                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| `effective bindings: stored takes precedence`         | Merge logic when stored + seed both exist           |
| `effective bindings: seed fills empty digits`         | Empty digit = first un-bound class by idx           |
| `effective bindings: seed skips already-bound classes` | No duplicates                                       |
| `panel renders kbd badge for bound digits`            | UI snapshot of bound + unbound rows                 |
| `Shift+digit on active class dispatches bind mutation` | Keyboard wiring (positive path)                     |
| `Shift+digit with no active class shows info toast`   | No mutation fires                                   |
| `Shift+digit on currently-bound digit clears`         | Unbind path                                         |
| `plain digit activates bound class`                   | Activation path                                     |
| `plain digit with no binding is a no-op`              | Edge case                                           |
| `class deletion → badge disappears after refetch`     | Cache invalidation path                             |
| `one-time hint fires once and persists localStorage`  | Hint UX                                             |

## Open questions

None at design time — all UX choices were nailed down in the brainstorm (per-user/project persistence, Shift+digit modifier, seed defaults with one-time hint).

## Out-of-scope follow-ups

- Hotkey export/import as part of project settings JSON
- Cross-project default profile ("apply my Bus=1 mapping to every project with a Bus class")
- Keyboard cheat sheet auto-updating to show the user's actual bindings instead of generic `1..9 = Switch active class`
- Numpad digit support (`KeyboardEvent.key` already covers numpad digits as `"1".."9"` on most layouts — verify in implementation)

# Plan 13 — Phase 7: Workspace polish, dataset versioning, search, quality dashboards, brand logo

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** four parallel tracks closing the gaps that make the product feel like a hobbyist tool today, plus a real brand logo.

1. **Workspace & permissions polish** — per-project membership + roles, audit log of irreversible / billing-relevant actions, invite flow, SSO entry point.
2. **Dataset versioning** — every retrain and every export snapshots an immutable dataset; compare versions side-by-side; rollback button.
3. **Search & saved views** — global asset search, jump-to-annotation, server-side saved filters per task, shareable URLs.
4. **Quality dashboards** — per-reviewer accept rate, per-class precision/recall after each retrain, time-on-task surfacing.
5. **Brand logo** — a real mark replacing the text wordmark.

## Series context

- ✅ Plans 01–08 shipped (foundation through deployment polish)
- ✅ v3.9.x — Plan 09 + 09b (Phase 5: review/QA, active learning, perf, editor polish)
- ✅ v3.10.x — Plan 11 + 12 (Phase 6: SAM 3.1 native package end-to-end)
- **Plan 13 — Phase 7** ← *this plan*

---

## Track A — Workspace & permissions polish

### Task 1: Project membership schema

**Files:**
- new `apps/api/alembic/versions/0023_project_members.py`
- modify `apps/api/src/carve_api/projects/models.py` (add `ProjectMember` model)
- modify `apps/api/src/carve_api/projects/schemas.py`
- new `apps/api/tests/projects/test_membership.py`

**Spec:**
- New `project_members` table: `(project_id uuid FK CASCADE, user_id uuid FK CASCADE, role text, added_by uuid FK SET NULL, added_at timestamptz)`. Composite primary key `(project_id, user_id)`.
- Roles: `owner | admin | member | viewer`. `owner` is set automatically on project creation; transferable. `viewer` is read-only.
- `ProjectIn` schema gains an optional `members: list[{user_id, role}]` for create-time invites; defaults to empty.
- Backfill migration: every existing project gets an `owner` row pointing at `Project.created_by`. If `created_by` is null (legacy), the workspace's first admin becomes the owner.

**Tests:**
- Migration up + down on a clean DB; existing projects land with one owner row each.
- Composite PK prevents duplicate `(project_id, user_id)` rows.
- `ProjectIn(members=[…])` round-trips.

### Task 2: Membership-aware access checks

**Files:**
- modify `apps/api/src/carve_api/projects/service.py` (`list_visible`, `require_visible_task`, plus `require_project_role(db, user, project_id, role)`)
- modify every router that currently uses `require_visible_task` (already canonical) — no changes if they only check task visibility, but **add** role-aware gates on mutating endpoints
- new `apps/api/tests/projects/test_membership_acl.py`

**Spec:**
- `require_project_role(db, user, project_id, allowed_roles: tuple[str, ...])` returns the project or raises `NotProjectMember(AppError, 403)` / `InsufficientRole(AppError, 403)`.
- Workspace `admin` users implicitly have `owner` on every project (matches the existing global admin escape hatch).
- `list_visible` returns projects where the user has any membership (or workspace-admin sees all).
- Mutating endpoints (create/update/delete project; create/update/delete tasks/classes; submit retrain; submit export) require `member|admin|owner`.
- Reviewer endpoints (`POST /annotations/{id}/review`, `POST /annotations/batch:review`) require `member|admin|owner`. `viewer` 403s.
- Read endpoints accept any membership including `viewer`.

**Tests:**
- Each role hits each endpoint matrix → asserts 200/403 as documented.
- Workspace-admin escape hatch verified.

### Task 3: Audit log

**Files:**
- new `apps/api/alembic/versions/0024_audit_log.py`
- new `apps/api/src/carve_api/audit/__init__.py`, `models.py`, `service.py`, `router.py`, `schemas.py`
- modify `apps/api/src/carve_api/main.py` (mount router)
- new `apps/api/tests/audit/test_audit_log.py`

**Spec:**
- `audit_events` table: `(id uuid PK, occurred_at timestamptz, actor_id uuid FK SET NULL, action text, target_type text, target_id uuid|null, project_id uuid FK SET NULL|null, summary text, metadata jsonb|null)`.
- Indexes: `(project_id, occurred_at desc)`, `(actor_id, occurred_at desc)`, `(action, occurred_at desc)`.
- `AuditService.record(action, target_type, target_id, *, actor, project_id=None, summary, metadata=None)`. Best-effort — never raises into the calling business logic; logs and swallows on failure.
- Wire the recorder at:
  - Annotation accept/reject (single + batch).
  - Retrain submit + cancel + completion.
  - Export submit + completion + download.
  - Project member add/remove/role-change.
  - Task delete.
- `GET /projects/{pid}/audit?limit=&cursor=&action=&actor=` — paginated list, `member|admin|owner` only.

**Tests:**
- `record(...)` writes a row with the expected shape.
- `record(...)` swallows on a synthetic DB failure (mock the session) and the calling action still succeeds.
- Filter by `action`, `actor`, date range.

### Task 4: Invitation flow

**Files:**
- new `apps/api/alembic/versions/0025_project_invites.py`
- new `apps/api/src/carve_api/invites/__init__.py`, `models.py`, `service.py`, `router.py`, `schemas.py`
- modify `apps/api/src/carve_api/main.py`
- new `apps/web/src/pages/InviteAcceptPage.tsx`
- modify `apps/web/src/pages/Phase2Pages.tsx` (add the per-project members UI)
- modify `apps/web/src/api/projects.ts`
- new `apps/api/tests/invites/test_invites.py`
- new `apps/web/tests/invite-accept.test.tsx`

**Spec:**
- Backend:
  - `project_invites(id uuid PK, project_id uuid FK CASCADE, email citext, role text, token_hash text unique, invited_by uuid FK SET NULL, created_at timestamptz, expires_at timestamptz, accepted_at timestamptz|null, accepted_by uuid FK SET NULL|null)`.
  - `POST /projects/{pid}/invites` body `{email, role}` — owner/admin only. Generates a 32-byte URL-safe token; stores its sha256; returns the raw token in the 201 response (only time it's visible). Sets 7-day expiry.
  - `GET /projects/{pid}/invites` — list pending invites.
  - `DELETE /projects/{pid}/invites/{id}` — revoke pending.
  - `POST /invites/accept` body `{token}` — looks up by token hash; if expired/already accepted → 410/409. Creates the user (if email not yet a user — trigger registration flow with the email pre-filled) or attaches the existing user as a project member with the invited role. Best-effort audit log.
- Frontend:
  - `InviteAcceptPage` route at `/invite/:token` — shows project name, prompts login/register, then completes the join.
  - In Settings → Members → per-project: member list + role chips + "Invite" form.

**Tests:**
- Token round-trip: created token works, expired token 410s.
- Re-using a redeemed token 409s.
- Creating an invite for an email that's already a member 409s.
- Project owner cannot demote themself.

### Task 5: SSO hook (entry point only)

**Files:**
- new `apps/api/src/carve_api/auth/sso.py`
- modify `apps/api/src/carve_api/auth/router.py` (`/auth/sso/{provider}/start`, `/auth/sso/{provider}/callback`)
- modify `apps/api/src/carve_api/config.py` (env: `SSO_PROVIDERS`, `OIDC_<provider>_*` triplet)
- new `apps/api/tests/auth/test_sso_oidc.py`

**Spec:**
- Generic OIDC provider abstraction. One concrete adapter — Google — plus the structure to plug others (Microsoft, Okta) by env config alone.
- `/auth/sso/{provider}/start?redirect_url=` returns a 302 to the IdP authorize endpoint with PKCE.
- `/auth/sso/{provider}/callback?code=&state=` exchanges code for ID token, verifies signature/issuer, looks up or creates the user keyed by `email`, issues our normal JWT, redirects to the original `redirect_url`.
- A new user created via SSO gets `UserRole.member` and is auto-added to no projects (admin invites them).
- SSO is **opt-in** per workspace via env; if `SSO_PROVIDERS` is unset/empty the routes return 404 to avoid info leakage.

**Tests (mocked OIDC discovery + token endpoints with httpx.MockTransport):**
- Start route returns 302 with the right state + PKCE.
- Callback creates a new user and issues a JWT.
- Repeat callback for an existing email upgrades the existing user to SSO-linked (sets `sso_subject`).
- Bad state / replayed nonce → 400.

---

## Track B — Dataset versioning

### Task 6: `DatasetVersion` model + service

**Files:**
- new `apps/api/alembic/versions/0026_dataset_versions.py`
- new `apps/api/src/carve_api/datasets/__init__.py`, `models.py`, `service.py`, `router.py`, `schemas.py`
- modify `apps/api/src/carve_api/main.py`
- modify `apps/api/src/carve_api/jobs/retrain.py` and `apps/api/src/carve_api/exports/job.py` to write a snapshot
- new `apps/api/tests/datasets/test_datasets.py`

**Spec:**
- `dataset_versions(id uuid PK, project_id uuid FK CASCADE, task_id uuid FK CASCADE, kind text, source text, created_by uuid FK SET NULL, created_at timestamptz, label text, frozen bool, summary jsonb, blob_key text|null)`.
  - `kind`: `retrain | export | manual`.
  - `source`: a free-form reference (`retrain_job_id`, `export_id`, etc.).
  - `summary`: counts (`{annotations: 1234, accepted: 1100, rejected: 80, classes: ["car","person"]}`).
  - `blob_key`: MinIO key holding the canonical YOLO/COCO bundle (we already produce this for retrain + export — write the same zip).
- Retrain job: instead of throwing the dataset zip away after training, register a `DatasetVersion(kind='retrain', source=job_id, blob_key=…)` and link the produced Weight to it (`Weight.metadata_['retrain']['dataset_version_id']`).
- Export job: register `DatasetVersion(kind='export', source=export_id, blob_key=export_zip_key)`.
- Endpoints under `/projects/{pid}/datasets`:
  - `GET …` — list (filter by kind, task, date).
  - `GET …/{id}` — detail incl. presigned download URL.
  - `GET …/{id}/diff/{other_id}` — symmetric diff: annotations added/removed/changed grouped by class. Uses the on-disk YOLO labels + a small in-process differ.
  - `POST …/{id}/rollback?task_id=` — replaces the active task's annotations with the snapshot's. Audit-logged. Permission: `admin|owner`.

**Tests:**
- Retrain job populates a DatasetVersion row.
- Diff endpoint returns added/removed counts.
- Rollback only swaps the requested task and is reversible (a fresh DatasetVersion is created right before the rollback so rollback-of-rollback works).

### Task 7: Web — datasets page + compare/rollback UI

**Files:**
- new `apps/web/src/pages/DatasetsPage.tsx`
- modify `apps/web/src/routes/projects.$projectId.tsx`
- modify `apps/web/src/api/datasets.ts` (new file)
- modify `apps/web/src/components/annotation/RetrainDialog.tsx` (link to the new dataset version)
- new `apps/web/tests/datasets-page.test.tsx`

**Spec:**
- New "Datasets" tab on the project detail page.
- Lists versions with: timestamp, label, kind chip, counts, "Compare" + "Rollback" actions.
- Compare opens a modal with a side-by-side mini-summary plus a paginated list of changed annotations (mask preview thumbnails when available).
- Rollback shows a confirm dialog with the count delta and writes via the new endpoint.

**Tests:**
- Renders 5 versions, compare opens with mocked diff, rollback fires the API + invalidates the dataset query.

---

## Track C — Search & saved views

### Task 8: Backend search endpoints

**Files:**
- modify `apps/api/src/carve_api/assets/router.py` — extend `GET /tasks/{tid}/assets` filter set with: `q` (filename substring), `min_annotations`, `max_annotations`, `class_id`, `status` (any of proposed/accepted/rejected). The first three already exist or are partially there; add the rest.
- new `apps/api/src/carve_api/search/__init__.py`, `service.py`, `router.py`, `schemas.py`
- new `apps/api/alembic/versions/0027_saved_views.py`
- new `apps/api/src/carve_api/views/models.py` etc. (saved view model)
- new `apps/api/tests/search/test_search.py`
- new `apps/api/tests/views/test_saved_views.py`

**Spec:**
- `GET /search/assets?q=&workspace=true&project_id=&task_id=&kind=&class_id=&min_size=&max_size=&status=&limit=&cursor=` — global asset search across the projects the caller has membership on. Returns hits with project + task + asset + thumbnail URL + match snippet.
- `saved_views(id uuid PK, task_id uuid FK CASCADE, owner uuid FK SET NULL, name text, query jsonb, created_at, updated_at, shared bool)`.
  - `query` stores the filter shape (status, class_id, min/max size, etc.).
  - When `shared=true`, any project member can use it; otherwise only the owner.
- `POST /tasks/{tid}/views` `GET /tasks/{tid}/views` `DELETE /views/{id}` `PATCH /views/{id}`.

**Tests:**
- Search respects membership (a viewer in project A can't see project B's assets even if they match the query).
- Shareable view round-trips.

### Task 9: Web — global search bar + saved views

**Files:**
- new `apps/web/src/components/search/GlobalSearchBar.tsx` (mounted in TopBar)
- new `apps/web/src/components/search/SavedViewsMenu.tsx` (in the editor's right rail or above the asset thumbnails)
- modify `apps/web/src/components/nav/TopBar.tsx`
- modify `apps/web/src/pages/AnnotateAssetPage.tsx` (consume the active saved view)
- modify `apps/web/src/api/views.ts` (new)
- new `apps/web/tests/global-search-bar.test.tsx`
- new `apps/web/tests/saved-views-menu.test.tsx`

**Spec:**
- Cmd/Ctrl-K opens the search palette: text input, debounced 200 ms, returns asset hits across the workspace. Pressing Enter on a hit navigates to that asset.
- Editor right-rail gets "Views" pill: dropdown of saved views, "+ Save current". Selecting a view re-applies its filters and updates the URL with `?view=<id>`.
- `?view=<id>` and `?status=accepted&class_id=…` URL params load the view on mount; saved views persist as the default.

**Tests:**
- Typing in the search palette fires the API.
- Selecting a saved view filters the displayed annotations.
- Saving the current filter set creates a row.

---

## Track D — Quality dashboards

### Task 10: Backend stats — reviewer accept rate, retrain metrics over time

**Files:**
- modify `apps/api/src/carve_api/stats/sql.py` and `service.py`
- modify `apps/api/src/carve_api/stats/router.py`
- new `apps/api/tests/stats/test_quality.py`

**Spec:**
- `GET /projects/{pid}/stats/reviewer-quality` returns rows `{reviewer_id, name, total_reviewed, accepted, rejected, accept_rate}` over a date range.
- `GET /projects/{pid}/stats/retrain-history` returns the project's weights ordered by created_at, exposing `metadata.retrain.metrics` (mAP, fitness, etc.) so the UI can chart precision/recall progression.
- `GET /tasks/{tid}/stats/per-class-quality` returns per-class accepted/rejected counts and the per-class proxy-precision (= accepted / proposed).

**Tests:**
- The reviewer quality query returns deterministic numbers on a small fixture.
- Retrain history rows are sorted ascending and only include weights with metadata.

### Task 11: Web — Quality dashboard tab

**Files:**
- modify `apps/web/src/pages/StatsPanel.tsx` (or extract `apps/web/src/components/stats/QualityDashboard.tsx`)
- modify `apps/web/src/api/phase2.ts` or new `apps/web/src/api/stats.ts`
- new `apps/web/tests/quality-dashboard.test.tsx`

**Spec:**
- New "Quality" tab next to existing stats. Three sections:
  1. Reviewer quality — table with sparkline of accept rate over time.
  2. Per-class precision — bar chart of accept rate per class.
  3. Retrain history — line chart of mAP / val-loss across recent weights, with retrain timestamps as x-axis points.
- Time-on-task (already computed) gets surfaced here too, with a "per-annotator" filter.

**Tests:**
- Renders the three charts with mocked data; chart libraries already in the bundle (recharts).

---

## Track E — Brand logo

### Task 12: Logo + favicon + product mark

**Files:**
- new `apps/web/public/logo.svg`, `logo-mark.svg`, `logo-wordmark.svg`, `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`
- new `apps/docs/public/logo.svg`
- modify `apps/web/index.html` (favicon link tags)
- modify `apps/web/src/components/nav/TopBar.tsx` (replace text wordmark with `<Logo />`)
- new `apps/web/src/components/brand/Logo.tsx` (renders the SVG; accepts `size`, `variant: "mark" | "full"`)
- new `apps/web/tests/logo.test.tsx`
- modify `apps/docs/.vitepress/config.ts` (set `logo`)

**Brief for the design:**
- Product is **VisualAutoAnnotator** ("Carve"). It's a vision annotation platform — image + video — with active-learning retrain and SAM 3.1-driven semantic segmentation.
- Visual concept: a chisel/knife mark sculpting an outline (literal but sharp). Or a simplified abstract shape suggesting "selecting a region with intent" — e.g. a polygon nibbling out of a square.
- One-colour mark first (works on dark + light backdrops); colour-positive variant uses the existing accent (the `oklch(0.78 0.16 215)` cyan-leaning blue from the editor).
- Mark scales cleanly to 16 px (favicon) and 256 px (splash).
- Wordmark uses **Fraunces** (already loaded as a project font) for "Carve" with a tighter tracking on the `v` to suggest the cut/segment idea.

**Implementation:**
- Hand-crafted SVG (no AI image generator). Keep raw SVG path d-strings under 1 KB so the favicon stays small.
- The `<Logo />` component supports `variant="mark" | "full" | "stacked"`.

**Tests:**
- TopBar renders `<Logo variant="full" />` and the SVG is present in the DOM.
- 404 page / login page also use the logo.

---

## Self-Review Checklist

- [ ] Project membership rows back-filled on existing projects.
- [ ] Workspace admin still sees all projects.
- [ ] Viewer role 403s on every mutating endpoint.
- [ ] Audit events fire on accept/reject/retrain/export/membership changes.
- [ ] Invitation token round-trip works; expired tokens 410.
- [ ] SSO callback creates a user + issues JWT (mocked OIDC).
- [ ] Retrain produces a DatasetVersion linked from the new Weight.
- [ ] Export produces a DatasetVersion.
- [ ] Diff endpoint returns counts; rollback swaps annotations and audit-logs.
- [ ] Cmd-K opens global search; navigates to the picked asset.
- [ ] Saved view persists in URL + reloads filters.
- [ ] Quality dashboard renders three charts with real data.
- [ ] Logo replaces the text wordmark in TopBar; favicon shows in browser tab.
- [ ] No regression in existing test suites.

## Tag

`v3.11.0 — Phase 7: workspace + permissions, dataset versioning, search, quality dashboards, brand logo`

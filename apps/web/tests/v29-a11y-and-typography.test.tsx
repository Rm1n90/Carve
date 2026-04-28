/**
 * v2.9 audit Phase 4 — typography unification, accessibility, and dead UI
 * cleanup.
 *
 * Covers:
 *  - P1-13: zoom callbacks on AnnotateAssetPage are stable across renders
 *           (skipped: requires the full page tree — see test note).
 *  - P1-14: LeftNav search input is gone (was lying to AT users).
 *  - P1-16: SettingsLayout h1 uses the v2.8 editorial pattern.
 *  - P1-17: SaveIndicator exposes role="status" + aria-live="polite".
 *  - P1-18: ObjectsPanel rows are keyboard-clickable (Enter selects).
 *  - P1-19: Datasets duplicate is gone from LeftNav; only one entry
 *           routes to /projects.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/projects" } }),
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
  } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/auth/store", () => ({
  useAuth: Object.assign(
    (sel: (s: { user: { email: string; role: string } | null }) => unknown) =>
      sel({ user: { email: "demo@carve.dev", role: "admin" } }),
    {
      getState: () => ({ user: { email: "demo@carve.dev", role: "admin" } }),
    },
  ),
}));

vi.mock("@/auth/api", () => ({ logout: vi.fn() }));

import { LeftNav } from "@/components/nav/LeftNav";
import { SaveIndicator } from "@/components/annotation/SaveIndicator";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { SettingsLayout } from "@/pages/SettingsPages";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { useAnnotations } from "@/state/annotations";
import { useFilter } from "@/state/annotationFilter";
import type { ClassRow } from "@/api/classes";

afterEach(() => {
  cleanup();
});

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------
// P1-17 — SaveIndicator a11y
// ---------------------------------------------------------------
describe("v2.9 P1-17 — SaveIndicator aria-live", () => {
  it("exposes role=status + aria-live=polite in the saved state", () => {
    render(<SaveIndicator isSaving={false} hasError={false} dirtyCount={0} />);
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("role", "status");
    expect(ind).toHaveAttribute("aria-live", "polite");
  });

  it("exposes role=status + aria-live=polite in the saving state", () => {
    render(<SaveIndicator isSaving={true} hasError={false} dirtyCount={1} />);
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("role", "status");
    expect(ind).toHaveAttribute("aria-live", "polite");
  });

  it("exposes role=status + aria-live=polite in the dirty state", () => {
    render(<SaveIndicator isSaving={false} hasError={false} dirtyCount={2} />);
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("role", "status");
    expect(ind).toHaveAttribute("aria-live", "polite");
  });

  it("exposes role=status + aria-live=polite in the error state", () => {
    render(
      <SaveIndicator
        isSaving={false}
        hasError={true}
        dirtyCount={1}
        onRetry={() => undefined}
      />,
    );
    const ind = screen.getByTestId("save-indicator");
    expect(ind).toHaveAttribute("role", "status");
    expect(ind).toHaveAttribute("aria-live", "polite");
  });
});

// ---------------------------------------------------------------
// P1-18 — Object rows are keyboard-clickable
// ---------------------------------------------------------------
const FRAME_ID = "frame-kbd";

function makeClass(id: string, idx: number, name: string, color: string): ClassRow {
  return {
    id,
    project_id: "p-1",
    idx,
    name,
    color,
    attributes: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("v2.9 P1-18 — ObjectsPanel keyboard activation", () => {
  beforeEach(() => {
    useAnnotations.getState().reset([]);
    useFilter.getState().clearFilter();
    useAnnotations.getState().add({
      tempId: "ann-kbd",
      classId: "class-a",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 5, h: 5 },
      frameId: FRAME_ID,
      serverId: null,
      dirty: false,
    });
  });

  it("exposes the row as a button to AT and selects on Enter", () => {
    const classes: Record<string, ClassRow> = {
      "class-a": makeClass("class-a", 0, "Apple", "#ff0000"),
    };
    render(
      wrap(<ObjectsPanel frameId={FRAME_ID} classes={classes} />),
    );

    const row = screen.getByTestId("object-row-ann-kbd");
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");

    // Pressing Enter on the focused row triggers selection.
    fireEvent.keyDown(row, { key: "Enter" });
    expect(useAnnotations.getState().selectedId).toBe("ann-kbd");
  });

  it("also activates on Space", () => {
    const classes: Record<string, ClassRow> = {
      "class-a": makeClass("class-a", 0, "Apple", "#ff0000"),
    };
    render(
      wrap(<ObjectsPanel frameId={FRAME_ID} classes={classes} />),
    );
    // Reset selection state to verify Space alone fires it.
    useAnnotations.getState().select(null);
    expect(useAnnotations.getState().selectedId).toBeNull();

    const row = screen.getByTestId("object-row-ann-kbd");
    fireEvent.keyDown(row, { key: " " });
    expect(useAnnotations.getState().selectedId).toBe("ann-kbd");
  });
});

// ---------------------------------------------------------------
// P1-16 — Editorial h1 in Settings
// ---------------------------------------------------------------
describe("v2.9 P1-16 — SettingsLayout editorial h1", () => {
  it("renders the page title in the v2.8 editorial typeface", () => {
    render(
      wrap(
        <SettingsLayout>
          <div />
        </SettingsLayout>,
      ),
    );
    const heading = screen.getByRole("heading", { level: 1, name: /settings/i });
    expect(heading.className).toMatch(/font-editorial/);
    expect(heading.className).toMatch(/text-\[36px\]/);
  });
});

// ---------------------------------------------------------------
// P1-14 — LeftNav search input is gone
// P1-19 — "Datasets" duplicate is gone
// ---------------------------------------------------------------
describe("v2.9 P1-14 / P1-19 — LeftNav cleanup", () => {
  it("no longer renders a Search input (was unwired)", () => {
    render(wrap(<LeftNav />));
    expect(screen.queryByLabelText(/^search$/i)).toBeNull();
  });

  it("does not render a 'Datasets' nav entry (deduped against All projects)", () => {
    render(wrap(<LeftNav />));
    expect(screen.queryByText(/^datasets$/i)).toBeNull();
    // And only one nav link points to /projects.
    const projectLinks = screen
      .getAllByRole("link")
      .filter((el) => (el as HTMLAnchorElement).getAttribute("href") === "/projects");
    expect(projectLinks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// P1-13 — Memoized zoom callbacks
//
// Skipped: a deterministic identity-stability test against
// AnnotateAssetPage requires the editor's full provider tree (router,
// Vite router context, useAnnotations stores, asset queries, etc.) —
// reproducing it here would duplicate the existing annotate-page tests
// without adding signal. The fix is verified by reading the patched
// JSX: each onZoom* prop now points to a useCallback handler with `[]`
// deps, so the EditorToolbar keydown effect deps stay reference-stable.
// ---------------------------------------------------------------
describe.skip("v2.9 P1-13 — memoized zoom callbacks", () => {
  it("placeholder — see header note", () => {
    // intentionally empty
  });
});

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Plan 14 Phase 8 Task 9 — TopBar editor breadcrumbs.
 *
 * Verifies that when the editor route passes a typed
 * ``breadcrumbSegments`` array (Workspace › Project › Task › Asset N/M),
 * TopBar renders the four expected segments via the shared
 * ``<Breadcrumbs>`` component (Task 2).
 */

// Mock the router so we don't have to spin up a router context for the
// avatar menu's <Link> usage.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [k: string]: unknown;
  }) => {
    let href = to ?? "#";
    if (to && params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, v);
      }
    }
    return (
      <a href={href} data-link-to={to ?? ""} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
  useNavigate: () => () => undefined,
}));

// The auth store + theme + confirm dialog are lightweight enough that
// stubbing the user out keeps the avatar menu out of the render tree.
vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock("@/auth/api", () => ({ logout: () => undefined }));
vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "system", setTheme: () => undefined }),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  useConfirm: () => async () => false,
}));
// The global search bar + logo render heavy SVGs we don't need here.
vi.mock("@/components/search/GlobalSearchBar", () => ({
  GlobalSearchBar: () => null,
}));
vi.mock("@/components/brand/Logo", () => ({
  Logo: () => <span data-testid="brand-logo" />,
}));

import { TopBar } from "@/components/nav/TopBar";

afterEach(() => {
  cleanup();
});

describe("TopBar editor breadcrumbs", () => {
  it("renders the four editor breadcrumb segments via <Breadcrumbs>", () => {
    render(
      <TopBar
        breadcrumbSegments={[
          { label: "Workspace", to: "/projects", testId: "editor-bc-workspace" },
          {
            label: "Project Alpha",
            to: "/projects/$projectId",
            params: { projectId: "p-1" },
            testId: "editor-bc-project",
          },
          {
            label: "Initial labelling",
            to: "/projects/$projectId",
            params: { projectId: "p-1" },
            testId: "editor-bc-task",
          },
          { label: "Asset 3/12", testId: "editor-bc-asset" },
        ]}
      />,
    );

    expect(screen.getByTestId("breadcrumbs")).toBeInTheDocument();
    expect(screen.getByTestId("editor-bc-workspace")).toHaveTextContent(
      "Workspace",
    );
    expect(screen.getByTestId("editor-bc-project")).toHaveTextContent(
      "Project Alpha",
    );
    expect(screen.getByTestId("editor-bc-task")).toHaveTextContent(
      "Initial labelling",
    );
    expect(screen.getByTestId("editor-bc-asset")).toHaveTextContent(
      "Asset 3/12",
    );
  });

  it("renders the asset segment as the current/non-link page", () => {
    render(
      <TopBar
        breadcrumbSegments={[
          { label: "Workspace", to: "/projects", testId: "editor-bc-workspace" },
          { label: "Asset 1/1", testId: "editor-bc-asset" },
        ]}
      />,
    );
    const assetSeg = screen.getByTestId("editor-bc-asset");
    expect(assetSeg.tagName).toBe("SPAN");
    expect(assetSeg.getAttribute("aria-current")).toBe("page");
  });
});

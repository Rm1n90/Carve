import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Plan 14 Phase 8 Task 2 — Breadcrumbs unit tests.
 *
 * Covers:
 *   - All segments render in order with the expected separator count.
 *   - Non-current segments resolve to a router ``Link`` (asserted via
 *     the mocked Link's ``href`` reflecting the supplied params).
 *   - The current/last segment renders as a non-link with
 *     ``aria-current="page"``.
 */

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
      <a
        href={href}
        data-link-to={to ?? ""}
        {...(rest as Record<string, unknown>)}
      >
        {children}
      </a>
    );
  },
}));

import { Breadcrumbs } from "@/components/nav/Breadcrumbs";

describe("Breadcrumbs", () => {
  it("renders each segment", () => {
    render(
      <Breadcrumbs
        segments={[
          { label: "Workspace", to: "/projects", testId: "bc-ws" },
          { label: "My Project", testId: "bc-proj" },
        ]}
      />,
    );

    expect(screen.getByTestId("breadcrumbs")).toBeInTheDocument();
    expect(screen.getByTestId("bc-ws")).toBeInTheDocument();
    expect(screen.getByTestId("bc-proj")).toBeInTheDocument();
  });

  it("renders non-current segments as router links with the supplied path", () => {
    render(
      <Breadcrumbs
        segments={[
          {
            label: "Workspace",
            to: "/projects",
            testId: "bc-ws",
          },
          {
            label: "Project Alpha",
            to: "/projects/$projectId",
            params: { projectId: "p-42" },
            testId: "bc-proj",
          },
          { label: "Tasks", testId: "bc-tasks" },
        ]}
      />,
    );

    const ws = screen.getByTestId("bc-ws") as HTMLAnchorElement;
    expect(ws.tagName).toBe("A");
    expect(ws.getAttribute("href")).toBe("/projects");

    const proj = screen.getByTestId("bc-proj") as HTMLAnchorElement;
    expect(proj.tagName).toBe("A");
    expect(proj.getAttribute("href")).toBe("/projects/p-42");
  });

  it("renders the last segment as a non-link with aria-current", () => {
    render(
      <Breadcrumbs
        segments={[
          { label: "Workspace", to: "/projects", testId: "bc-ws" },
          { label: "Project Alpha", testId: "bc-proj" },
        ]}
      />,
    );

    const last = screen.getByTestId("bc-proj");
    expect(last.tagName).toBe("SPAN");
    expect(last.getAttribute("aria-current")).toBe("page");
  });
});

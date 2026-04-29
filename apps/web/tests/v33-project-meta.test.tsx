import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

// v3.3 Issue 2 — ProjectCard renders a meta row "Created … · {owner_email}".
// This test locks in the contract.

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    "aria-label": aria,
    className,
  }: {
    children: React.ReactNode;
    params?: { projectId?: string };
    "aria-label"?: string;
    className?: string;
  }) => (
    <a aria-label={aria} className={className} data-testid="project-card-link">
      {children}
    </a>
  ),
}));

import { ProjectCard } from "@/components/ProjectCard";

function renderCard(node: React.ReactElement) {
  return render(<ConfirmProvider>{node}</ConfirmProvider>);
}

describe("v3.3 Issue 2 — ProjectCard meta row", () => {
  it("renders a meta row with 'Created' label and owner email", () => {
    // Use a date one day ago so the relative formatter is deterministic.
    const oneDayAgoISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const project = {
      id: "p-1",
      name: "Meta Project",
      description: "v3.3 audit issue 2 fixture",
      owner_id: "u-1",
      owner_email: "user@example.com",
      created_at: oneDayAgoISO,
    };
    renderCard(<ProjectCard project={project} onDelete={() => undefined} />);
    const meta = screen.getByTestId("project-card-meta");
    expect(meta.textContent).toMatch(/Created/);
    expect(meta.textContent).toMatch(/user@example\.com/);
    // Relative-time formatter should produce "1 day ago" for ~24h delta.
    expect(meta.textContent).toMatch(/1 day ago/);
  });

  it("falls back to 'Unknown' when owner_email is null", () => {
    const project = {
      id: "p-2",
      name: "No Owner",
      description: null,
      owner_id: "u-2",
      owner_email: null,
      created_at: "2026-04-25T10:00:00Z",
    };
    renderCard(<ProjectCard project={project} onDelete={() => undefined} />);
    const meta = screen.getByTestId("project-card-meta");
    expect(meta.textContent).toMatch(/Unknown/);
  });
});

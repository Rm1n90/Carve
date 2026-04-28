import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function renderCard(node: React.ReactElement) {
  return render(<ConfirmProvider>{node}</ConfirmProvider>);
}

// Stub @tanstack/react-router so the Link renders as a plain <a> with the
// href reflecting the resolved path. This lets us verify the entire row is
// wrapped in a clickable link (audit bug 5: previously a clickable absolute
// overlay was buried under a z-10 content div, eating clicks meant for
// the link).
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    "aria-label": aria,
    className,
  }: {
    children: React.ReactNode;
    params?: { projectId?: string };
    "aria-label"?: string;
    className?: string;
  }) => (
    <a
      href={params?.projectId ? `/projects/${params.projectId}` : "#"}
      aria-label={aria}
      className={className}
      data-testid="project-card-link"
    >
      {children}
    </a>
  ),
}));

import { ProjectCard } from "@/components/ProjectCard";

const project = {
  id: "p-42",
  name: "Demo Project",
  description: "A sample dataset",
  owner_id: "u-1",
  created_at: "2026-04-25",
};

describe("ProjectCard (audit bug 5 — click hit-zone)", () => {
  it("renders the project name and description INSIDE the navigation link", () => {
    renderCard(<ProjectCard project={project} onDelete={() => undefined} />);
    const link = screen.getByTestId("project-card-link");
    // The visible name and description must live inside the Link element so
    // any click on them navigates to /projects/<id>.
    expect(link).toContainElement(screen.getByText("Demo Project"));
    expect(link).toContainElement(screen.getByText("A sample dataset"));
    expect(link.getAttribute("href")).toBe("/projects/p-42");
  });

  it("clicking the project name does not propagate to the Delete button", () => {
    const onDelete = vi.fn();
    renderCard(<ProjectCard project={project} onDelete={onDelete} />);
    fireEvent.click(screen.getByText("Demo Project"));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("delete button opens v2.8 ConfirmDialog and only calls onDelete when confirmed", async () => {
    const onDelete = vi.fn();
    renderCard(<ProjectCard project={project} onDelete={onDelete} />);
    const btn = screen.getByRole("button", { name: /delete project/i });
    fireEvent.click(btn);
    // The dialog renders inside a portal — wait for the title to appear,
    // then click "Delete" to commit.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(1);
    });
  });

  it("delete button is a sibling of the link, not nested inside it", () => {
    // The delete button is a SIBLING of the link (not nested inside it),
    // so clicking it must not produce an <a> traversal. We assert by
    // checking that the link is NOT an ancestor of the button.
    renderCard(<ProjectCard project={project} onDelete={() => undefined} />);
    const link = screen.getByTestId("project-card-link");
    const btn = screen.getByRole("button", { name: /delete project/i });
    expect(link.contains(btn)).toBe(false);
    expect(btn.closest("a")).toBeNull();
  });
});

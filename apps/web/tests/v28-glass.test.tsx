/**
 * v2.8 Wave 3 — Liquid Glass aesthetic regression check.
 *
 * Asserts that the chrome surfaces opt into the glass utility classes
 * shipped in `apps/web/src/styles/global.css`. We intentionally check
 * the className strings rather than the computed style — jsdom doesn't
 * implement `backdrop-filter`, so a visual assertion is impractical and
 * the class application is the contract Wave 3 ships.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/Tooltip";

// Stub the router APIs the chrome reads — same approach as
// annotate-page.test.tsx so the test stays focused on the glass class.
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
      sel({ user: { email: "demo@carve.dev", role: "owner" } }),
    {
      getState: () => ({ user: { email: "demo@carve.dev", role: "owner" } }),
    },
  ),
}));

vi.mock("@/auth/api", () => ({ logout: vi.fn() }));

vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

import { TopBar } from "@/components/nav/TopBar";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

describe("v2.8 Wave 3 — Liquid Glass aesthetic", () => {
  it("TopBar applies the glass-surface-strong utility to the nav strip", () => {
    render(
      <ConfirmProvider>
        <TooltipProvider>
          <TopBar />
        </TooltipProvider>
      </ConfirmProvider>,
    );

    const bar = screen.getByTestId("top-bar");
    expect(bar.className).toMatch(/glass-surface-strong/);
    expect(bar.className).toMatch(/glass-specular/);
  });

  it("TopBar user-menu trigger opts into glass-chip styling", () => {
    render(
      <ConfirmProvider>
        <TooltipProvider>
          <TopBar />
        </TooltipProvider>
      </ConfirmProvider>,
    );

    const trigger = screen.getByTestId("topbar-user-menu");
    expect(trigger.className).toMatch(/glass-chip/);
  });

  it("right-panel className contract — glass-surface-strong is on the panel surface", async () => {
    // We grep the AnnotateAssetPage source rather than mounting it, since
    // the editor pulls in the canvas + Pixi + router + classes mutations.
    // The contract Wave 3 ships is "the right panel `<aside>` carries
    // glass-surface-strong" — so we read the source and assert the class
    // appears on the same JSX element as the right-panel testid. This is
    // a brittle but cheap snapshot — it catches an accidental revert
    // without needing a full editor mount.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "../src/pages/AnnotateAssetPage.tsx"),
      "utf8",
    );
    const idx = src.indexOf('data-testid="right-panel-aside"');
    expect(idx).toBeGreaterThan(-1);
    // Look in a 600-char window after the testid for the glass utility.
    const window = src.slice(idx, idx + 600);
    expect(window).toMatch(/glass-surface-strong/);
  });

  it("FrameTimeline container references the corrected --glass-bg-strong token", () => {
    const { container } = render(
      <FrameTimeline totalFrames={3} currentIdx={0} onChange={() => {}} />,
    );
    const slider = container.querySelector('[role="slider"]') as HTMLElement | null;
    expect(slider).not.toBeNull();
    expect(slider!.className).toMatch(/var\(--glass-bg-strong\)/);
    expect(slider!.className).not.toMatch(/var\(--bg-glass-strong\)/);
  });

  it("StatsPanel cardClass uses the glass-surface utility (rounded-2xl)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(__dirname, "../src/pages/StatsPanel.tsx"),
      "utf8",
    );
    expect(src).toMatch(/cardClass\s*=\s*"[^"]*glass-surface[^"]*"/);
    expect(src).toMatch(/cardClass\s*=\s*"[^"]*rounded-2xl[^"]*"/);
  });
});

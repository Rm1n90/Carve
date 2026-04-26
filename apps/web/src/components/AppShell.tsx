import { type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Cpu, LogOut } from "lucide-react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

/**
 * Carve logotype — a stylized geometric "C" formed by two arcs offset
 * over a 1px border. Drawn inline as SVG so it can sit in the chrome
 * with no asset roundtrips.
 */
function CarveMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-6 w-6", className)}
      aria-hidden
    >
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="7.25"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="1"
      />
      <path
        d="M22 11.5c-1.4-1.6-3.5-2.6-5.8-2.6-4.3 0-7.7 3.5-7.7 7.7s3.5 7.7 7.7 7.7c2.3 0 4.4-1 5.8-2.6"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M22 17.6c-.6-.7-1.5-1.1-2.4-1.1-1.8 0-3.2 1.5-3.2 3.2s1.4 3.2 3.2 3.2c.9 0 1.8-.4 2.4-1.1"
        stroke="var(--accent)"
        strokeOpacity="0.55"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Breadcrumb() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (path === "/" || path === "/login" || path === "/register") return null;
  const isProjects = path.startsWith("/projects");
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[12px]">
      <span className="text-tertiary">/</span>
      <Link
        to="/projects"
        className={cn(
          "tracking-tight transition-colors",
          isProjects ? "text-primary" : "text-secondary hover:text-primary",
        )}
      >
        Projects
      </Link>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-screen flex-col">
        <header
          className={cn(
            "sticky top-0 z-40 flex h-14 items-center gap-4 px-6",
            "border-b border-[var(--border-subtle)]",
            "bg-[var(--bg-glass-strong)] backdrop-blur-xl",
          )}
        >
          <Link
            to="/"
            className="group inline-flex items-center gap-2.5 text-primary"
            aria-label="Carve home"
          >
            <CarveMark />
            <span className="text-[16px] font-medium tracking-tight">
              Carve
              <span className="ml-1 align-text-top text-[10px] text-tertiary font-mono-data">
                v2
              </span>
            </span>
          </Link>

          <Breadcrumb />

          <div className="flex-1" />

          <Tooltip content="Inference: SAM-Hiera Tiny • ready">
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-2 h-8 px-3",
                "rounded-full border border-[var(--border-subtle)]",
                "bg-[var(--bg-surface)] text-secondary",
                "hover:border-[var(--border-strong)] hover:text-primary",
                "transition-colors text-[12px]",
              )}
            >
              <Cpu className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span className="tracking-tight">SAM</span>
              <span className="font-mono-data text-tertiary">·</span>
              <span className="font-mono-data text-[var(--success)] text-[10px]">ready</span>
            </button>
          </Tooltip>

          {user && (
            <div className="flex items-center gap-3">
              <div className="hidden md:flex flex-col items-end leading-tight">
                <span className="text-[12px] text-primary tracking-tight">{user.email}</span>
                <Badge variant="ghost" size="sm">
                  {user.role}
                </Badge>
              </div>
              <Tooltip content="Sign out">
                <IconButton
                  size="sm"
                  aria-label="Sign out"
                  onClick={() => {
                    logout();
                    nav({ to: "/login" });
                  }}
                >
                  <LogOut className="h-4 w-4" />
                </IconButton>
              </Tooltip>
            </div>
          )}
        </header>
        <main className="flex-1 px-6 py-8">{children}</main>
      </div>
    </TooltipProvider>
  );
}

/**
 * Edge-to-edge variant for the annotation editor — no padding, no scroll.
 * The editor manages its own three-panel layout.
 */
export function AppShellBleed({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-hidden">{children}</div>
    </TooltipProvider>
  );
}

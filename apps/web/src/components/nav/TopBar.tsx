import { Link, useNavigate } from "@tanstack/react-router";
import { LogOut, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { CarveMark } from "./CarveMark";
import { Tooltip } from "@/components/ui/Tooltip";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

interface BreadcrumbCrumb {
  label: ReactNode;
  to?: string;
}

interface TopBarProps {
  /** Optional breadcrumb segments rendered between the wordmark and the right action group. */
  crumbs?: BreadcrumbCrumb[];
  /** Optional right-side action node (e.g. a Save / Build button). */
  rightAction?: ReactNode;
}

/**
 * Top chrome — 48px tall white bar. Wordmark left, optional breadcrumb,
 * action button + avatar right.
 */
export function TopBar({ crumbs, rightAction }: TopBarProps) {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();

  const userInitial = user?.email ? user.email[0]?.toUpperCase() : "?";

  return (
    <header
      className={cn(
        "h-12 shrink-0 flex items-center gap-3 px-4",
        "border-b border-[var(--border-subtle)] bg-[var(--bg-app)]",
      )}
    >
      <Link to="/" aria-label="Carve home" className="shrink-0">
        <CarveMark />
      </Link>

      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-tertiary)]"
                aria-hidden
              />
              {c.to ? (
                <Link
                  to={c.to}
                  className="text-[13px] tracking-tight text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] truncate"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="text-[13px] tracking-tight text-[color:var(--text-primary)] truncate">
                  {c.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="flex-1" />

      {rightAction}

      {user && (
        <div className="flex items-center gap-2">
          <Tooltip content={user.email}>
            <span
              className="grid h-7 w-7 place-items-center rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] text-[12px] font-medium tracking-tight"
              aria-label={`User ${user.email}`}
            >
              {userInitial}
            </span>
          </Tooltip>
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
  );
}

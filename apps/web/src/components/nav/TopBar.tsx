import { Link, useNavigate } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  User as UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { useTheme, type ThemePreference } from "@/components/theme/ThemeProvider";
import { CarveMark } from "./CarveMark";
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
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  Icon: typeof Moon;
}> = [
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
];

export function TopBar({ crumbs, rightAction }: TopBarProps) {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const { theme, setTheme } = useTheme();

  const userInitial = user?.email ? user.email[0]?.toUpperCase() : "?";

  return (
    <header
      data-testid="top-bar"
      className={cn(
        "relative h-12 shrink-0 flex items-center gap-3 px-4",
        "glass-surface-strong glass-specular",
        // glass-surface already paints a hairline border; keep the layout
        // border-bottom as a fallback so non-supporting browsers still get
        // a visible separator.
        "border-b border-[var(--glass-border)]",
      )}
    >
      <Link to="/" aria-label="Carve home" className="shrink-0 relative z-10">
        <CarveMark />
      </Link>

      {crumbs && crumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="relative z-10 flex items-center gap-1 min-w-0"
        >
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-[color:var(--text-tertiary)]"
                aria-hidden
              />
              {c.to ? (
                <Link
                  to={c.to}
                  className="text-[13px] tracking-tight text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] truncate transition-colors"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center h-7 px-2 rounded-full",
                    "glass-chip text-[12.5px] tracking-tight font-medium",
                    "text-[color:var(--text-primary)] truncate",
                  )}
                >
                  {c.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      )}

      <div className="flex-1" />

      <span className="relative z-10 inline-flex items-center gap-2">
        {rightAction}
      </span>

      {user && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="topbar-user-menu"
              className={cn(
                "relative z-10 flex items-center gap-1.5 px-1.5 h-8 rounded-full",
                "glass-chip",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              )}
              aria-label={`Account menu for ${user.email}`}
            >
              <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] text-[12px] font-medium tracking-tight">
                {userInitial}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className={cn(
                "min-w-[220px] rounded-[var(--radius-md)]",
                "glass-surface-strong p-1 z-50",
              )}
            >
              <div className="px-2 py-2 grid gap-0.5">
                <p className="text-[12.5px] tracking-tight text-[color:var(--text-primary)] truncate">
                  {user.email}
                </p>
                <p className="text-[10.5px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                  {user.role}
                </p>
              </div>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
              <DropdownMenu.Item asChild>
                <Link
                  to="/settings/profile"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
                >
                  <UserIcon className="h-3.5 w-3.5" /> Profile
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <Link
                  to="/settings/profile"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
                >
                  <SettingsIcon className="h-3.5 w-3.5" /> Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
              <DropdownMenu.Label
                className="px-2 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wider text-[color:var(--text-tertiary)]"
              >
                Theme
              </DropdownMenu.Label>
              <div role="radiogroup" aria-label="Theme">
                {THEME_OPTIONS.map((opt) => {
                  const selected = theme === opt.value;
                  return (
                    <DropdownMenu.Item
                      key={opt.value}
                      data-testid={`theme-option-${opt.value}`}
                      role="menuitemradio"
                      aria-checked={selected}
                      onSelect={(event) => {
                        // Keep the menu open after selection so users can
                        // preview themes before dismissing.
                        event.preventDefault();
                        setTheme(opt.value);
                      }}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px]",
                        "hover:bg-[var(--bg-hover)] cursor-pointer outline-none",
                        selected && "text-[color:var(--accent)]",
                      )}
                    >
                      <opt.Icon className="h-3.5 w-3.5" aria-hidden />
                      <span className="flex-1">{opt.label}</span>
                      {selected && <Check className="h-3.5 w-3.5" aria-hidden />}
                    </DropdownMenu.Item>
                  );
                })}
              </div>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
              <DropdownMenu.Item
                onSelect={() => {
                  logout();
                  nav({ to: "/login" });
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px] text-[color:var(--danger)] hover:bg-[var(--danger-bg)] cursor-pointer outline-none"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </header>
  );
}

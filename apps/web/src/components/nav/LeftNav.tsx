import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Boxes,
  ChevronDown,
  Cpu,
  KeyRound,
  LogOut,
  Pencil,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Trash2,
  User as UserIcon,
  Users,
} from "lucide-react";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { cn } from "@/lib/cn";

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  initiallyOpen?: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
  children?: React.ReactNode;
}

function Section({
  label,
  icon,
  initiallyOpen = true,
  disabled,
  disabledTooltip,
  children,
}: SectionProps) {
  const [open, setOpen] = useState(initiallyOpen);
  if (disabled) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)]",
          "text-[12px] font-medium tracking-tight text-[color:var(--text-disabled)] cursor-not-allowed select-none",
        )}
        title={disabledTooltip}
      >
        <span className="text-[color:var(--text-disabled)]">{icon}</span>
        <span className="flex-1 text-left">{label}</span>
        <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-disabled)]">
          soon
        </span>
      </div>
    );
  }
  return (
    <div className="grid gap-0.5">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)]",
          "text-[12px] font-medium tracking-tight text-[color:var(--text-secondary)]",
          "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] transition-colors",
        )}
      >
        <span className="text-[color:var(--text-tertiary)]">{icon}</span>
        <span className="flex-1 text-left">{label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-[color:var(--text-tertiary)] transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      {open && children && <ul className="grid gap-0.5">{children}</ul>}
    </div>
  );
}

interface NavItemProps {
  label: string;
  to?: string;
  active?: boolean;
  icon?: React.ReactNode;
}

function NavItem({ label, to, active, icon }: NavItemProps) {
  const inner = (
    <span
      className={cn(
        "relative flex items-center gap-2 pl-5 pr-2 py-1.5",
        "text-[13px] tracking-tight",
        active
          ? "bg-[var(--bg-hover)] text-[color:var(--text-primary)]"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r-[2px]"
        />
      )}
      {icon && <span className="text-[color:var(--text-tertiary)]">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
    </span>
  );
  if (to) {
    return (
      <li>
        <Link to={to} className="block">
          {inner}
        </Link>
      </li>
    );
  }
  return <li>{inner}</li>;
}

function isActive(path: string, target: string, exact = true): boolean {
  if (exact) return path === target;
  return path === target || path.startsWith(target + "/");
}

export function LeftNav() {
  const [query, setQuery] = useState("");
  const path = useRouterState({ select: (s) => s.location.pathname });
  const user = useAuth((s) => s.user);
  const nav = useNavigate();

  const userInitial = user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <aside
      aria-label="Primary navigation"
      className={cn(
        "w-[220px] shrink-0 h-full flex flex-col",
        "border-r border-[var(--border-subtle)] bg-[var(--bg-nav)]",
      )}
    >
      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search
            aria-hidden
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[color:var(--text-tertiary)] pointer-events-none"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search"
            className={cn(
              "w-full h-8 pl-8 pr-2 rounded-[var(--radius-sm)]",
              "bg-[var(--bg-app)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
              "border border-[var(--border-subtle)] text-[12.5px]",
              "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.16)]",
            )}
          />
        </div>
      </div>

      {/* Workspace label + active pill */}
      <div className="px-3 pt-2 pb-2 grid gap-1.5">
        <p className="text-[10px] tracking-[0.08em] uppercase text-[color:var(--text-tertiary)] font-medium">
          Workspace
        </p>
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)]">
          <span className="grid h-5 w-5 place-items-center rounded-[3px] bg-[var(--accent)] text-white text-[10px] font-medium">
            C
          </span>
          <span className="text-[13px] tracking-tight font-medium">Carve</span>
        </div>
      </div>

      {/* Sections */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 grid gap-2 content-start">
        <Section label="Annotate" icon={<Pencil className="h-3.5 w-3.5" />} initiallyOpen>
          <NavItem
            label="Datasets"
            to="/projects"
            active={isActive(path, "/projects", false)}
            icon={<Boxes className="h-3.5 w-3.5" />}
          />
          <NavItem
            label="All projects"
            to="/projects"
            active={path === "/projects"}
          />
        </Section>

        <Section label="Models" icon={<Cpu className="h-3.5 w-3.5" />} initiallyOpen={false}>
          <NavItem
            label="YOLO weights"
            to="/models/yolo"
            active={isActive(path, "/models/yolo")}
          />
          <NavItem
            label="SAM models"
            to="/models/sam"
            active={isActive(path, "/models/sam")}
            icon={<Sparkles className="h-3.5 w-3.5" />}
          />
        </Section>

        <Section
          label="Train"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          disabled
          disabledTooltip="Cloud training is v2 — currently using local inference only."
        />

        <Section
          label="Deploy"
          icon={<Rocket className="h-3.5 w-3.5" />}
          disabled
          disabledTooltip="Cloud training is v2 — currently using local inference only."
        />

        <Section label="Account" icon={<UserIcon className="h-3.5 w-3.5" />} initiallyOpen={false}>
          <NavItem
            label="Settings"
            to="/settings/profile"
            active={isActive(path, "/settings", false)}
            icon={<Settings className="h-3.5 w-3.5" />}
          />
          <NavItem
            label="Members"
            to="/settings/members"
            active={isActive(path, "/settings/members")}
            icon={<Users className="h-3.5 w-3.5" />}
          />
          <NavItem
            label="API Keys"
            to="/settings/api-keys"
            active={isActive(path, "/settings/api-keys")}
            icon={<KeyRound className="h-3.5 w-3.5" />}
          />
          <NavItem
            label="Trash"
            to="/trash"
            active={isActive(path, "/trash", false)}
            icon={<Trash2 className="h-3.5 w-3.5" />}
          />
        </Section>
      </nav>

      {/* Footer: user dropdown */}
      {user && (
        <div className="border-t border-[var(--border-subtle)] px-2 py-2">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={cn(
                  "w-full flex items-center gap-2 px-1.5 py-1.5 rounded-[var(--radius-sm)]",
                  "text-left hover:bg-[var(--bg-hover)] transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                )}
                aria-label="Account menu"
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] text-[11px] font-medium">
                  {userInitial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] tracking-tight truncate text-[color:var(--text-primary)]">
                    {user.email}
                  </span>
                  <span className="block text-[10.5px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                    {user.role}
                  </span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-[color:var(--text-tertiary)]" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                className={cn(
                  "min-w-[180px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
                  "shadow-[var(--shadow-elev-2)] p-1 z-50",
                )}
              >
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
                    <Settings className="h-3.5 w-3.5" /> Settings
                  </Link>
                </DropdownMenu.Item>
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
        </div>
      )}
    </aside>
  );
}

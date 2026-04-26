import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  ChevronDown,
  Home,
  Compass,
  Pencil,
  Cpu,
  Rocket,
  Settings,
  Trash2,
  MessageSquare,
} from "lucide-react";
import { projectsApi, type Project } from "@/api/projects";
import { cn } from "@/lib/cn";

const SWATCH_VARS = [
  "var(--swatch-0)",
  "var(--swatch-1)",
  "var(--swatch-2)",
  "var(--swatch-3)",
  "var(--swatch-4)",
  "var(--swatch-5)",
  "var(--swatch-6)",
  "var(--swatch-7)",
  "var(--swatch-8)",
  "var(--swatch-9)",
  "var(--swatch-10)",
  "var(--swatch-11)",
] as const;

function projectColor(id: string): string {
  // Stable per-id hue so the same project keeps its dot color across renders.
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SWATCH_VARS[h % SWATCH_VARS.length];
}

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  initiallyOpen?: boolean;
  children: React.ReactNode;
}

function Section({ label, icon, initiallyOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(initiallyOpen);
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
      {open && <ul className="grid gap-0.5">{children}</ul>}
    </div>
  );
}

interface NavItemProps {
  label: string;
  to?: string;
  active?: boolean;
  swatch?: string;
  count?: number;
  icon?: React.ReactNode;
  disabled?: boolean;
}

function NavItem({ label, to, active, swatch, count, icon, disabled }: NavItemProps) {
  const inner = (
    <span
      className={cn(
        "relative flex items-center gap-2 pl-5 pr-2 py-1.5",
        "text-[13px] tracking-tight",
        active
          ? "bg-[var(--bg-hover)] text-[color:var(--text-primary)]"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)] rounded-r-[2px]"
        />
      )}
      {swatch && (
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: swatch }}
        />
      )}
      {icon && <span className="text-[color:var(--text-tertiary)]">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {typeof count === "number" && (
        <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)] tabular-nums">
          {count}
        </span>
      )}
    </span>
  );
  if (to && !disabled) {
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

/**
 * Left navigation rail — 220px wide, light gray. Search input at top, three
 * collapsible sections (Annotate / Train / Deploy) with project sub-items,
 * footer with Settings/Trash/Feedback.
 */
export function LeftNav() {
  const [query, setQuery] = useState("");
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const path = useRouterState({ select: (s) => s.location.pathname });

  const projects = (projectsQ.data ?? []) as Project[];
  const filtered = query
    ? projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    : projects;

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
            placeholder="Search"
            aria-label="Search projects"
            className={cn(
              "w-full h-8 pl-8 pr-2 rounded-[var(--radius-sm)]",
              "bg-[var(--bg-app)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
              "border border-[var(--border-subtle)] text-[12.5px]",
              "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.16)]",
            )}
          />
        </div>
      </div>

      {/* Sections */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 grid gap-2 content-start">
        <ul className="grid gap-0.5">
          <NavItem
            label="Home"
            to="/"
            active={path === "/"}
            icon={<Home className="h-3.5 w-3.5" />}
          />
          <NavItem
            label="Explore"
            icon={<Compass className="h-3.5 w-3.5" />}
            disabled
          />
        </ul>

        <Section
          label="Annotate"
          icon={<Pencil className="h-3.5 w-3.5" />}
          initiallyOpen
        >
          {filtered.length === 0 && !projectsQ.isLoading && (
            <li className="px-5 py-1 text-[12px] text-[color:var(--text-tertiary)] italic">
              No projects.
            </li>
          )}
          {filtered.map((p) => (
            <NavItem
              key={p.id}
              label={p.name}
              to={`/projects/${p.id}`}
              active={path === `/projects/${p.id}` || path.startsWith(`/projects/${p.id}/`)}
              swatch={projectColor(p.id)}
            />
          ))}
        </Section>

        <Section label="Train" icon={<Cpu className="h-3.5 w-3.5" />} initiallyOpen={false}>
          <NavItem label="Coming soon" disabled />
        </Section>

        <Section label="Deploy" icon={<Rocket className="h-3.5 w-3.5" />} initiallyOpen={false}>
          <NavItem label="Coming soon" disabled />
        </Section>
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--border-subtle)] px-2 py-2 grid gap-0.5">
        <NavItem
          label="Settings"
          icon={<Settings className="h-3.5 w-3.5" />}
          disabled
        />
        <NavItem label="Trash" icon={<Trash2 className="h-3.5 w-3.5" />} disabled />
        <NavItem
          label="Feedback"
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          disabled
        />
      </div>
    </aside>
  );
}

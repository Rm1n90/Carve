// Armin Mehri — mehri.armin@gmail.com
/**
 * v3.24.9 — "Edge" left nav redesign.
 *
 * Goals: modern, minimalist, spectacular without being noisy.
 *
 * Layout (top → bottom):
 *
 *   ┌─────────────────────────┐
 *   │  ◆ Carve                │  brand mark (no chip, no Workspace label)
 *   ├─────────────────────────┤
 *   │  PROJECTS         12    │  section label + count
 *   │                         │
 *   │  ▌ Project A            │  active project: 2px accent beam left
 *   │  │ Task 1                │
 *   │  │ Task 2                │
 *   │    Project B            │
 *   │    Project C            │
 *   │                         │
 *   │  See all 24 projects →  │
 *   │ (scroll)                │
 *   ├─────────────────────────┤
 *   │  [⚙] [📊] [🔑] [🗑] [ℹ] │  icon dock (h-9, tooltipped)
 *   ├─────────────────────────┤
 *   │  ⊙  alex@example.com ⌄  │  slim user footer
 *   └─────────────────────────┘
 *
 * Visual rules:
 *   - One signature element: a 2px ``--accent`` beam on the left edge
 *     of the active row. No glow, no gradient overlay, no chip.
 *   - Section labels: 10 px, uppercase, tracking-[0.10em], muted.
 *     Just typography — no icon, no chevron, no surrounding chrome.
 *   - Hover: subtle ``bg-[var(--bg-hover)]`` tint. No scale, no shadow.
 *   - Section disclosures (Models / Train / Deploy / Account / Help)
 *     collapsed into a single icon dock at the bottom. Train and Deploy
 *     v2-stubs removed entirely — they belonged in a roadmap, not the nav.
 *   - User footer slimmed from ~50 px to a single 36 px row.
 *
 * Existing data-testids preserved: ``leftnav-project-{id}``,
 * ``leftnav-task-{id}``, ``leftnav-projects-loading``,
 * ``leftnav-all-projects``, ``leftnav-projects-show-all``,
 * ``leftnav-project-link-{id}``, ``leftnav-project-toggle-{id}``,
 * ``leftnav-tasks-loading-{id}``, ``leftnav-tasks-more-{id}``.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  HelpCircle,
  Info,
  LogOut,
  Settings,
  Trash2,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { projectsApi, type Project } from "@/api/projects";
import { tasksApi } from "@/api/tasks";

const ANNOTATE_PROJECTS_LIMIT = 8;
const ANNOTATE_TASKS_LIMIT = 5;

// ---------------------------------------------------------------------------
// Atomic primitives
// ---------------------------------------------------------------------------

interface SectionLabelProps {
  children: React.ReactNode;
  /** Optional right-aligned counter (e.g. project total). */
  count?: number;
}
function SectionLabel({ children, count }: SectionLabelProps) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
      <span className="text-[10px] uppercase tracking-[0.10em] font-medium text-[color:var(--text-tertiary)]">
        {children}
      </span>
      {typeof count === "number" && count > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-tertiary)]">
          {count}
        </span>
      )}
    </div>
  );
}

interface NavRowProps {
  active?: boolean;
  /** Indent multiple of the row's left padding (0 = root, 1 = nested task). */
  indent?: 0 | 1;
  children: React.ReactNode;
}
/**
 * Single-row chrome shared by the project link, the task link, the
 * "see all projects" link, and any other top-level nav row. The active
 * accent beam lives here so every row gets it for free.
 */
function NavRow({ active = false, indent = 0, children }: NavRowProps) {
  return (
    <span
      className={cn(
        "relative flex items-center gap-2 mx-1.5 py-1.5 rounded-[var(--radius-sm)]",
        "text-[12.5px] tracking-tight transition-colors duration-[160ms] ease-out",
        indent === 0 ? "pl-3 pr-2" : "pl-6 pr-2",
        active
          ? "text-[color:var(--text-primary)] bg-[var(--bg-hover)]/60"
          : "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]/40",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-[2px] bg-[var(--accent)]"
        />
      )}
      {children}
    </span>
  );
}

interface NavItemProps {
  label: string;
  to?: string;
  params?: Record<string, string>;
  active?: boolean;
  testId?: string;
  /** Right-aligned subtle annotation, e.g. "→" arrow for see-all rows. */
  trailing?: React.ReactNode;
}
function NavItem({ label, to, params, active, testId, trailing }: NavItemProps) {
  const inner = (
    <NavRow active={active}>
      <span className="flex-1 truncate">{label}</span>
      {trailing && <span className="text-[color:var(--text-tertiary)]">{trailing}</span>}
    </NavRow>
  );
  if (to) {
    const AnyLink = Link as unknown as React.FC<
      Record<string, unknown> & { children?: React.ReactNode }
    >;
    return (
      <li>
        <AnyLink to={to} params={params} className="block" data-testid={testId}>
          {inner}
        </AnyLink>
      </li>
    );
  }
  return <li data-testid={testId}>{inner}</li>;
}

function isActive(path: string, target: string, exact = true): boolean {
  if (exact) return path === target;
  return path === target || path.startsWith(target + "/");
}

// ---------------------------------------------------------------------------
// Project + task disclosure
// ---------------------------------------------------------------------------

interface ProjectNavItemProps {
  project: Project;
  path: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}
function ProjectNavItem({ project, path, expanded, onToggle }: ProjectNavItemProps) {
  const projectBase = "/projects/" + project.id;
  const taskMatch = path.startsWith(projectBase + "/tasks/");
  const projectActive =
    (path === projectBase || path.startsWith(projectBase + "/")) && !taskMatch;

  // Lazy-fetch tasks only when the disclosure is expanded — avoids the
  // N+1 fan-out from a user with many projects.
  const tasksQ = useQuery({
    queryKey: ["tasks", project.id],
    queryFn: () => tasksApi.listForProject(project.id),
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });
  const tasks = tasksQ.data ?? [];
  const visibleTasks = tasks.slice(0, ANNOTATE_TASKS_LIMIT);
  const overflowTasks = tasks.length - visibleTasks.length;

  const AnyLink = Link as unknown as React.FC<
    Record<string, unknown> & { children?: React.ReactNode }
  >;

  return (
    <li data-testid={`leftnav-project-${project.id}`}>
      <NavRow active={projectActive}>
        <button
          type="button"
          onClick={() => onToggle(project.id)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          className={cn(
            "grid h-4 w-4 -ml-1 place-items-center shrink-0",
            "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] transition-colors",
          )}
          data-testid={`leftnav-project-toggle-${project.id}`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <AnyLink
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="flex-1 min-w-0 truncate"
          data-testid={`leftnav-project-link-${project.id}`}
        >
          {project.name}
        </AnyLink>
      </NavRow>
      {expanded && (
        <ul className="grid gap-0.5">
          {tasksQ.isLoading && (
            <li
              className="pl-7 pr-2 py-1 mx-1.5 text-[11.5px] text-[color:var(--text-tertiary)]"
              data-testid={`leftnav-tasks-loading-${project.id}`}
            >
              Loading…
            </li>
          )}
          {!tasksQ.isLoading &&
            visibleTasks.map((t) => {
              const taskActive = path.startsWith(projectBase + "/tasks/" + t.id);
              return (
                <li key={t.id} data-testid={`leftnav-task-${t.id}`}>
                  <AnyLink
                    to="/projects/$projectId/tasks/$taskId"
                    params={{ projectId: project.id, taskId: t.id }}
                    className="block"
                  >
                    <NavRow active={taskActive} indent={1}>
                      <span className="flex-1 truncate">{t.name}</span>
                    </NavRow>
                  </AnyLink>
                </li>
              );
            })}
          {!tasksQ.isLoading && overflowTasks > 0 && (
            <li data-testid={`leftnav-tasks-more-${project.id}`}>
              <AnyLink
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="block"
              >
                <NavRow indent={1}>
                  <span className="flex-1 text-[11.5px] text-[color:var(--text-tertiary)]">
                    + {overflowTasks} more
                  </span>
                </NavRow>
              </AnyLink>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Bottom icon dock — replaces Models / Train / Deploy / Account / Help
// ---------------------------------------------------------------------------

interface DockIconProps {
  label: string;
  to: string;
  active: boolean;
  icon: React.ReactNode;
  testId?: string;
}
function DockIcon({ label, to, active, icon, testId }: DockIconProps) {
  const AnyLink = Link as unknown as React.FC<
    Record<string, unknown> & { children?: React.ReactNode }
  >;
  return (
    <Tooltip content={label}>
      <AnyLink
        to={to}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]",
          "transition-colors duration-[160ms] ease-out",
          active
            ? "bg-[var(--bg-hover)]/60 text-[color:var(--accent)] shadow-[inset_0_0_0_1px_var(--accent)]"
            : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]/40",
        )}
        aria-label={label}
        data-testid={testId}
      >
        {icon}
      </AnyLink>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Main rail
// ---------------------------------------------------------------------------

export function LeftNav() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const confirm = useConfirm();

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    staleTime: 5 * 60 * 1000,
  });
  const projectList = projectsQ.data ?? [];
  const visibleProjects = projectList.slice(0, ANNOTATE_PROJECTS_LIMIT);
  const overflowCount = projectList.length - visibleProjects.length;

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Auto-expand the project that owns the active task route — preserves
  // deep-link UX from v3.1.
  useEffect(() => {
    const m = path.match(/^\/projects\/([^/]+)\/tasks\//);
    if (!m) return;
    const projectId = m[1];
    setExpandedProjects((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, [path]);

  const userInitial = user?.email?.[0]?.toUpperCase() ?? "?";

  async function handleSignOut() {
    const ok = await confirm({
      title: "Sign out?",
      description: "Any unsaved annotation work in the editor will be lost.",
      confirmLabel: "Sign out",
      variant: "danger",
    });
    if (ok) {
      logout();
      nav({ to: "/login" });
    }
  }

  return (
    <aside
      aria-label="Primary navigation"
      data-testid="left-nav"
      className={cn(
        "relative w-[220px] shrink-0 h-full flex flex-col",
        "glass-surface",
        "border-r border-[var(--glass-border)]",
      )}
    >
      {/* Brand mark — minimal. The diamond glyph is a small accent
          element so the wordmark feels intentional, not generic. */}
      <Link to="/" className="block">
        <div className="px-3 pt-3.5 pb-3 flex items-center gap-2 group">
          <span
            aria-hidden
            className={cn(
              "h-4 w-4 rotate-45 rounded-[2px] bg-[var(--accent)]",
              "shadow-[0_0_8px_oklch(0.78_0.14_220_/_0.35)]",
              "transition-transform duration-[400ms] ease-out group-hover:rotate-[225deg]",
            )}
          />
          <span className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
            Carve
          </span>
        </div>
      </Link>

      {/* Projects (primary IA — projects list IS the nav, no Section
          wrapper, no chevron, just a typography label + the list). */}
      <SectionLabel count={projectList.length}>Projects</SectionLabel>

      <nav className="relative flex-1 min-h-0 overflow-y-auto pb-1">
        <ul className="grid gap-0.5">
          {projectsQ.isLoading && (
            <li
              className="px-4 py-1.5 text-[11.5px] text-[color:var(--text-tertiary)]"
              data-testid="leftnav-projects-loading"
            >
              Loading…
            </li>
          )}
          {!projectsQ.isLoading &&
            visibleProjects.map((p) => (
              <ProjectNavItem
                key={p.id}
                project={p}
                path={path}
                expanded={expandedProjects.has(p.id)}
                onToggle={toggleProject}
              />
            ))}
          {!projectsQ.isLoading && overflowCount > 0 && (
            <NavItem
              label={`See all ${projectList.length} projects`}
              to="/projects"
              testId="leftnav-projects-show-all"
              trailing="→"
            />
          )}
          {!projectsQ.isLoading && projectList.length === 0 && (
            <NavItem
              label="All projects"
              to="/projects"
              active={path === "/projects"}
              testId="leftnav-all-projects"
            />
          )}
        </ul>
      </nav>

      {/* Icon dock — collapses Models / System / Settings / Trash /
          About into one tooltipped row. Replaces 4 separate sections
          and removes the v2-stub Train/Deploy entries entirely. */}
      <div
        role="navigation"
        aria-label="Secondary navigation"
        className={cn(
          "px-2 py-2 flex items-center gap-1",
          "border-t border-[var(--glass-border)]",
        )}
      >
        <DockIcon
          label="Models"
          to="/models/yolo"
          active={isActive(path, "/models", false)}
          icon={<Cpu className="h-3.5 w-3.5" />}
          testId="leftnav-dock-models"
        />
        <DockIcon
          label="System"
          to="/system"
          active={isActive(path, "/system", false)}
          icon={<Activity className="h-3.5 w-3.5" />}
          testId="leftnav-dock-system"
        />
        <DockIcon
          label="Settings"
          to="/settings/profile"
          active={isActive(path, "/settings", false)}
          icon={<Settings className="h-3.5 w-3.5" />}
          testId="leftnav-dock-settings"
        />
        <DockIcon
          label="Trash"
          to="/trash"
          active={isActive(path, "/trash", false)}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          testId="leftnav-dock-trash"
        />
        <DockIcon
          label="About"
          to="/about"
          active={isActive(path, "/about", false)}
          icon={<HelpCircle className="h-3.5 w-3.5" />}
          testId="leftnav-dock-about"
        />
      </div>

      {/* Slim user footer — single 36-px row. */}
      {user && (
        <div className="border-t border-[var(--glass-border)] px-2 py-1.5">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={cn(
                  "w-full h-9 flex items-center gap-2 px-1.5 rounded-[var(--radius-sm)]",
                  "text-left transition-colors",
                  "hover:bg-[var(--bg-hover)]/40",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                )}
                aria-label="Account menu"
              >
                <span
                  className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-medium shrink-0"
                  style={{
                    background: "var(--accent-bg)",
                    color: "var(--accent)",
                  }}
                >
                  {userInitial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] tracking-tight truncate text-[color:var(--text-primary)]">
                    {user.email}
                  </span>
                </span>
                <ChevronDown className="h-3 w-3 text-[color:var(--text-tertiary)] shrink-0" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                className={cn(
                  "min-w-[200px] rounded-[var(--radius-6)] p-1 z-50",
                  "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
                  "shadow-[var(--shadow-card)]",
                )}
              >
                <div className="px-2 py-1.5">
                  <span className="block text-[10.5px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                    Signed in as {user.role}
                  </span>
                  <span className="block text-[12px] tracking-tight truncate text-[color:var(--text-primary)] mt-0.5">
                    {user.email}
                  </span>
                </div>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
                <DropdownMenu.Item asChild>
                  <Link
                    to="/settings/profile"
                    className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
                  >
                    <Settings className="h-3.5 w-3.5" /> Settings
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <Link
                    to="/about"
                    className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
                  >
                    <Info className="h-3.5 w-3.5" /> About
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
                <DropdownMenu.Item
                  onSelect={(event) => {
                    event.preventDefault();
                    void handleSignOut();
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] text-[color:var(--danger)] hover:bg-[var(--danger-bg)] cursor-pointer outline-none"
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

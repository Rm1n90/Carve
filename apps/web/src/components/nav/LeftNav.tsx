import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  KeyRound,
  LogOut,
  Pencil,
  Rocket,
  Settings,
  Sparkles,
  Trash2,
  User as UserIcon,
  Users,
} from "lucide-react";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { projectsApi, type Project } from "@/api/projects";
import { tasksApi } from "@/api/tasks";

/**
 * v3.0 C5 — soft cap on how many projects we list inline under the
 * "Annotate" section. Anything beyond this gets hidden behind a
 * "Show all (N)" link to /projects so the nav rail stays scannable.
 */
const ANNOTATE_PROJECTS_LIMIT = 8;

/**
 * v3.1 Issue 5 — when a project is expanded, cap the nested task list at
 * this many rows. Beyond that we surface a "+ N more" overflow link to
 * the project detail page so the nav rail does not balloon.
 */
const ANNOTATE_TASKS_LIMIT = 5;

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
  /**
   * Optional TanStack Router params (e.g. `{ projectId: 'p1' }`) used when
   * `to` is a parametric path like `/projects/$projectId`. Typed loosely
   * so consumers don't need to import the per-route Param shapes.
   */
  params?: Record<string, string>;
  active?: boolean;
  icon?: React.ReactNode;
  /**
   * Optional test id for stable test selectors. Used by v3.0 C5 to
   * target the dynamic per-project nav items.
   */
  testId?: string;
}

function NavItem({ label, to, params, active, icon, testId }: NavItemProps) {
  const inner = (
    <span
      className={cn(
        "relative flex items-center gap-2 pl-5 pr-2 py-1.5 mx-1 rounded-[var(--radius-sm)]",
        "text-[13px] tracking-tight transition-colors duration-150",
        active
          ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
          : "text-[color:var(--text-secondary)] hover:bg-[var(--accent-bg)]/60 hover:text-[color:var(--text-primary)]",
      )}
    >
      {active && (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-1 bottom-1 w-[2px] rounded-r-[2px]",
              "bg-[var(--accent)]",
              "shadow-[0_0_10px_oklch(0.78_0.14_220_/_0.45)]",
            )}
          />
          {/* Subtle inner glow that hugs the row left edge — accentuates
              the active rail without pulling the eye off the label. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[var(--radius-sm)] bg-gradient-to-r from-[var(--accent-bg)] to-transparent opacity-60"
          />
        </>
      )}
      {icon && <span className="relative z-10 text-[color:var(--text-tertiary)]">{icon}</span>}
      <span className="relative z-10 flex-1 truncate">{label}</span>
    </span>
  );
  if (to) {
    // TanStack Router's `Link` typing is strict about route<->params, but
    // we accept generic `string` for `to` here because LeftNav links to a
    // mixed set of routes (some parametric, some not). Cast the Link to a
    // permissive shape for this navigation chrome.
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

/**
 * v3.1 Issue 5 — collapsible per-project disclosure used inside the
 * Annotate section. Renders a row with:
 *   - chevron toggle (expanded state lifted via `expanded` + `onToggle`)
 *   - project name link (click navigates to project detail — preserved
 *     behaviour from v3.0 C5)
 * When expanded, lazy-fetches tasks for this project and renders them
 * nested below at `pl-8`. Capped at ANNOTATE_TASKS_LIMIT with a
 * "+ N more" overflow link.
 *
 * Lazy fetch (`enabled: expanded`) avoids the N+1 fan-out where a user
 * with many projects would otherwise trigger a tasks query for every
 * project on mount.
 */
interface ProjectNavItemProps {
  project: Project;
  path: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function ProjectNavItem({
  project,
  path,
  expanded,
  onToggle,
}: ProjectNavItemProps) {
  const projectBase = "/projects/" + project.id;
  const taskMatch = path.startsWith(projectBase + "/tasks/");
  // Project row is "active" when we are on its detail OR a sub-route
  // (assets etc.), but NOT when a nested task row is the more specific
  // match — in that case the task row owns the highlight.
  const projectActive =
    (path === projectBase || path.startsWith(projectBase + "/")) && !taskMatch;

  const tasksQ = useQuery({
    queryKey: ["tasks", project.id],
    queryFn: () => tasksApi.listForProject(project.id),
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });

  const tasks = tasksQ.data ?? [];
  const visibleTasks = tasks.slice(0, ANNOTATE_TASKS_LIMIT);
  const overflowTasks = tasks.length - visibleTasks.length;

  // TanStack Router's `Link` typing is strict. Same workaround as NavItem.
  const AnyLink = Link as unknown as React.FC<
    Record<string, unknown> & { children?: React.ReactNode }
  >;

  return (
    <li data-testid={`leftnav-project-${project.id}`}>
      <div
        className={cn(
          "relative flex items-center gap-1 pr-2 py-1.5 mx-1 rounded-[var(--radius-sm)]",
          "text-[13px] tracking-tight transition-colors duration-150",
          projectActive
            ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
            : "text-[color:var(--text-secondary)] hover:bg-[var(--accent-bg)]/60 hover:text-[color:var(--text-primary)]",
        )}
      >
        {projectActive && (
          <>
            <span
              aria-hidden
              className={cn(
                "absolute left-0 top-1 bottom-1 w-[2px] rounded-r-[2px]",
                "bg-[var(--accent)]",
                "shadow-[0_0_10px_oklch(0.78_0.14_220_/_0.45)]",
              )}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-[var(--radius-sm)] bg-gradient-to-r from-[var(--accent-bg)] to-transparent opacity-60"
            />
          </>
        )}
        <button
          type="button"
          onClick={() => onToggle(project.id)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          className="relative z-10 grid h-4 w-4 ml-1 place-items-center text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] transition-colors"
          data-testid={`leftnav-project-toggle-${project.id}`}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <AnyLink
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="relative z-10 flex-1 min-w-0 truncate"
          data-testid={`leftnav-project-link-${project.id}`}
        >
          {project.name}
        </AnyLink>
      </div>
      {expanded && (
        <ul className="grid gap-0.5">
          {tasksQ.isLoading && (
            <li
              className="pl-8 pr-2 py-1 mx-1 text-[12px] text-[color:var(--text-tertiary)]"
              data-testid={`leftnav-tasks-loading-${project.id}`}
            >
              Loading…
            </li>
          )}
          {!tasksQ.isLoading &&
            visibleTasks.map((t) => {
              const taskActive = path.startsWith(
                projectBase + "/tasks/" + t.id,
              );
              return (
                <li key={t.id} data-testid={`leftnav-task-${t.id}`}>
                  <AnyLink
                    to="/projects/$projectId/tasks/$taskId"
                    params={{ projectId: project.id, taskId: t.id }}
                    className="block"
                  >
                    <span
                      className={cn(
                        "relative flex items-center gap-2 pl-8 pr-2 py-1.5 mx-1 rounded-[var(--radius-sm)]",
                        "text-[12.5px] tracking-tight transition-colors duration-150",
                        taskActive
                          ? "bg-[var(--accent-bg)] text-[color:var(--text-primary)]"
                          : "text-[color:var(--text-secondary)] hover:bg-[var(--accent-bg)]/60 hover:text-[color:var(--text-primary)]",
                      )}
                    >
                      {taskActive && (
                        <span
                          aria-hidden
                          className={cn(
                            "absolute left-0 top-1 bottom-1 w-[2px] rounded-r-[2px]",
                            "bg-[var(--accent)]",
                            "shadow-[0_0_10px_oklch(0.78_0.14_220_/_0.45)]",
                          )}
                        />
                      )}
                      <span className="relative z-10 flex-1 truncate">{t.name}</span>
                    </span>
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
                <span
                  className={cn(
                    "flex items-center pl-8 pr-2 py-1.5 mx-1 rounded-[var(--radius-sm)]",
                    "text-[12px] tracking-tight text-[color:var(--text-tertiary)]",
                    "hover:bg-[var(--accent-bg)]/60 hover:text-[color:var(--text-primary)] transition-colors",
                  )}
                >
                  + {overflowTasks} more
                </span>
              </AnyLink>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

export function LeftNav() {
  // v2.9 P1-14 — search input removed. The local `query` state had no
  // consumer (no nav search wired) and the aria-label="Search" was
  // misleading to AT users. Remove until a real search lands.
  const path = useRouterState({ select: (s) => s.location.pathname });
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  const confirm = useConfirm();

  // v3.0 C5 — list user projects directly in the Annotate section so the
  // most common nav target (a specific project) is one click away. We
  // cap inline rendering at ANNOTATE_PROJECTS_LIMIT and surface a
  // "Show all (N)" affordance for the overflow.
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    staleTime: 5 * 60 * 1000,
  });
  const projectList = projectsQ.data ?? [];
  const visibleProjects = projectList.slice(0, ANNOTATE_PROJECTS_LIMIT);
  const overflowCount = projectList.length - visibleProjects.length;

  // v3.1 Issue 5 — track which project disclosures are expanded. Session
  // only; we intentionally skip localStorage for this iteration. If a
  // task route is active (path matches /projects/$id/tasks/...) we
  // auto-expand that project on mount so the user lands with their
  // current location already in view.
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

  // Auto-expand the project that owns the active task route. We watch
  // path so deep-linking into /projects/$id/tasks/$tid expands $id even
  // if the user navigated there after mount.
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
        // glass-surface paints background + hairline border + backdrop
        // blur. We layer the existing atmospheric cyan radial on top so
        // the nav still feels alive at the crown.
        "glass-surface nav-atmosphere",
        // Keep an explicit right border as a non-blur fallback.
        "border-r border-[var(--glass-border)]",
      )}
    >
      {/* Workspace label + active pill */}
      <div className="relative z-10 px-3 pt-3 pb-2 grid gap-1.5">
        <p className="text-[10px] tracking-[0.08em] uppercase text-[color:var(--text-tertiary)] font-medium">
          Workspace
        </p>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded-full",
            "glass-chip",
          )}
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--accent)] text-[color:var(--accent-fg)] text-[10px] font-semibold">
            C
          </span>
          <span className="text-[13px] tracking-tight font-medium">Carve</span>
          <span
            aria-hidden
            className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_6px_oklch(0.78_0.14_220_/_0.6)]"
          />
        </div>
      </div>

      {/* Sections */}
      <nav className="relative z-10 flex-1 min-h-0 overflow-y-auto px-2 pb-2 grid gap-2 content-start">
        <Section label="Annotate" icon={<Pencil className="h-3.5 w-3.5" />} initiallyOpen>
          {/* v3.1 Issue 5 — project rows render FIRST as collapsible
              disclosures (each lazily fetches its task list when
              expanded). The "Show all (N)" overflow link follows, and
              the static "All projects" entry is now LAST so the user's
              own projects lead the section. */}
          {projectsQ.isLoading && (
            <li
              className="px-5 py-1 mx-1 text-[12px] text-[color:var(--text-tertiary)]"
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
              label={`Show all (${projectList.length})`}
              to="/projects"
              testId="leftnav-projects-show-all"
            />
          )}
          {/* v2.9 P1-19 — "Datasets" was a duplicate route to /projects.
              Removed pending a dedicated Datasets surface. */}
          <NavItem
            label="All projects"
            to="/projects"
            active={path === "/projects"}
            testId="leftnav-all-projects"
          />
        </Section>

        <Section label="Models" icon={<Cpu className="h-3.5 w-3.5" />} initiallyOpen={false}>
          <NavItem
            label="YOLO weights"
            to="/models/yolo"
            active={isActive(path, "/models/yolo")}
            icon={<Cpu className="h-3.5 w-3.5" />}
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
        <div className="relative z-10 border-t border-[var(--glass-border)] px-2 py-2">
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
                  "min-w-[180px] rounded-[var(--radius-md)]",
                  "glass-surface-strong p-1 z-50",
                )}
              >
                {/* v2.9 P1-19 — dedupe: Profile + Settings both routed to
                    /settings/profile. Keep Settings. */}
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
                  onSelect={(event) => {
                    // Defer the confirm call so Radix can finish dismissing
                    // the dropdown before opening the AlertDialog.
                    event.preventDefault();
                    void handleSignOut();
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

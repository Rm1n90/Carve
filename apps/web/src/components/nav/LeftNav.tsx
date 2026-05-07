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
import * as Popover from "@radix-ui/react-popover";
import { LayoutGroup, motion } from "framer-motion";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  HelpCircle,
  Info,
  LogOut,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { projectsApi, type Project } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { workspaceApi } from "@/api/workspace";
import { useBackgroundJobs } from "@/state/backgroundJobs";

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
        "group/row relative flex items-center gap-2 mx-1.5 py-1.5 rounded-[var(--radius-sm)]",
        "text-[12.5px] tracking-tight transition-colors duration-[160ms] ease-out",
        indent === 0 ? "pl-3 pr-2" : "pl-6 pr-2",
        active
          ? "text-[color:var(--text-primary)] bg-[var(--bg-hover)]/60"
          : "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]/40",
      )}
    >
      {/* Hover-preview beam: shows a faint accent stub on the left
          edge while the row is hovered (tells the user "this is what
          will become active"). Fades out on the active row because
          the real beam takes over. */}
      {!active && (
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-2 bottom-2 w-[2px] rounded-r-[2px]",
            "bg-[var(--accent)] opacity-0 group-hover/row:opacity-30",
            "transition-opacity duration-[160ms] ease-out",
          )}
        />
      )}
      {/* Active beam — uses framer-motion's layoutId so when the user
          navigates, the beam glides smoothly from the previous row's
          position to the new one. Single signature element of the
          rail's design language. */}
      {active && (
        <motion.span
          aria-hidden
          layoutId="leftnav-active-beam"
          className={cn(
            "absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-[2px]",
            "bg-[var(--accent)]",
            "shadow-[0_0_12px_oklch(0.78_0.14_220_/_0.55)]",
          )}
          transition={{
            type: "spring",
            stiffness: 480,
            damping: 38,
            mass: 0.8,
          }}
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
/**
 * Tooltipped dock icon for single-destination secondary nav. Active
 * state uses a 1 px inset accent ring + a small floating dot directly
 * underneath (macOS-dock style) so two visual cues confirm "you are
 * here" without shouting.
 */
function DockIcon({ label, to, active, icon, testId }: DockIconProps) {
  const AnyLink = Link as unknown as React.FC<
    Record<string, unknown> & { children?: React.ReactNode }
  >;
  return (
    <Tooltip content={label}>
      <span className="relative">
        <AnyLink
          to={to}
          className={cn(
            "grid h-9 w-9 place-items-center rounded-[var(--radius-sm)]",
            "transition-all duration-[160ms] ease-out",
            active
              ? "bg-[var(--bg-hover)]/60 text-[color:var(--accent)] shadow-[inset_0_0_0_1px_var(--accent)]"
              : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]/40 hover:-translate-y-px",
          )}
          aria-label={label}
          data-testid={testId}
        >
          {icon}
        </AnyLink>
        {active && (
          <motion.span
            aria-hidden
            layoutId="leftnav-dock-dot"
            className={cn(
              "absolute left-1/2 -translate-x-1/2 -bottom-1 h-[3px] w-[3px] rounded-full",
              "bg-[var(--accent)] shadow-[0_0_6px_oklch(0.78_0.14_220_/_0.7)]",
            )}
            transition={{ type: "spring", stiffness: 480, damping: 38 }}
          />
        )}
      </span>
    </Tooltip>
  );
}

/**
 * v3.24.10 — Models dock entry is a popover (not a single link)
 * because Models has two destinations (YOLO weights + SAM models)
 * and surfacing both costs only a click+hover. Other dock items
 * stay direct links because each is single-destination.
 */
function ModelsDockIcon({ active }: { active: boolean }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const yoloActive = isActive(path, "/models/yolo", false);
  const samActive = isActive(path, "/models/sam", false);
  const AnyLink = Link as unknown as React.FC<
    Record<string, unknown> & { children?: React.ReactNode }
  >;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <span className="relative">
          <button
            type="button"
            aria-label="Models"
            data-testid="leftnav-dock-models"
            className={cn(
              "grid h-9 w-9 place-items-center rounded-[var(--radius-sm)]",
              "transition-all duration-[160ms] ease-out",
              active
                ? "bg-[var(--bg-hover)]/60 text-[color:var(--accent)] shadow-[inset_0_0_0_1px_var(--accent)]"
                : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]/40 hover:-translate-y-px",
            )}
          >
            <Cpu className="h-4 w-4" />
          </button>
          {active && (
            <motion.span
              aria-hidden
              layoutId="leftnav-dock-dot"
              className={cn(
                "absolute left-1/2 -translate-x-1/2 -bottom-1 h-[3px] w-[3px] rounded-full",
                "bg-[var(--accent)] shadow-[0_0_6px_oklch(0.78_0.14_220_/_0.7)]",
              )}
              transition={{ type: "spring", stiffness: 480, damping: 38 }}
            />
          )}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className={cn(
            "min-w-[160px] rounded-[var(--radius-6)] p-1 z-50",
            "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
            "shadow-[var(--shadow-card)]",
          )}
        >
          <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.10em] font-medium text-[color:var(--text-tertiary)]">
            Models
          </div>
          {/* v3.24.11 — wrap each menu item with Popover.Close so a
              click both navigates AND dismisses the popover. Without
              this the menu would stay open behind the new page. */}
          <Popover.Close asChild>
            <AnyLink
              to="/models/yolo"
              data-testid="leftnav-dock-models-yolo"
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                "text-[12.5px] tracking-tight cursor-pointer outline-none",
                yoloActive
                  ? "text-[color:var(--accent)] bg-[var(--accent-bg)]"
                  : "text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
              )}
            >
              <Cpu className="h-3.5 w-3.5" />
              <span className="flex-1">YOLO weights</span>
            </AnyLink>
          </Popover.Close>
          <Popover.Close asChild>
            <AnyLink
              to="/models/sam"
              data-testid="leftnav-dock-models-sam"
              className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)]",
                "text-[12.5px] tracking-tight cursor-pointer outline-none",
                samActive
                  ? "text-[color:var(--accent)] bg-[var(--accent-bg)]"
                  : "text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)]",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="flex-1">SAM models</span>
            </AnyLink>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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

  // v3.24.10 — silent activity indicator on the avatar. When any
  // background batch (YOLOE / Auto-annotate / Predict / etc.) is
  // running, the avatar gets a thin pulsing accent ring. No badge,
  // no count, no toast — just a quiet "something is alive" signal.
  const activeJobs = useBackgroundJobs((s) => Object.keys(s.jobs).length);
  const hasActiveJobs = activeJobs > 0;

  // v3.24.11 — wire the brand wordmark to the live workspace name so
  // editing it in /settings/workspace flows through to the rail
  // instantly. Settings page invalidates ``["workspace"]`` on save
  // (SettingsPages.tsx:1074), so this query refetches automatically.
  const workspaceQ = useQuery({
    queryKey: ["workspace"],
    queryFn: workspaceApi.get,
    staleTime: 60_000,
  });
  const workspaceName = workspaceQ.data?.name ?? "Carve";

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
      {/* Brand mark — gradient diamond with a one-shot scan pulse on
          mount (a 600 ms vertical sweep across the glyph). The diamond
          rotates on hover and the wordmark gets a subtle letter-
          spacing tightening to feel tactile. */}
      <Link to="/" className="block">
        <div className="px-3 pt-3.5 pb-3 flex items-center gap-2.5 group">
          <span aria-hidden className="relative h-4 w-4">
            <span
              className={cn(
                "absolute inset-0 rotate-45 rounded-[2px]",
                "bg-gradient-to-br from-[var(--accent)] to-[oklch(0.62_0.20_240)]",
                "shadow-[0_0_10px_oklch(0.78_0.14_220_/_0.45)]",
                "transition-transform duration-[500ms] ease-out group-hover:rotate-[225deg]",
              )}
            />
            <motion.span
              className="absolute inset-0 rotate-45 rounded-[2px] overflow-hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 1.2, ease: "easeInOut" }}
            >
              <span
                className={cn(
                  "absolute -inset-y-2 w-[3px]",
                  "bg-gradient-to-b from-transparent via-white/60 to-transparent",
                )}
                style={{
                  animation: "leftnav-scan 1.2s ease-in-out 1",
                }}
              />
            </motion.span>
          </span>
          <span
            className={cn(
              "text-[14px] font-medium text-[color:var(--text-primary)]",
              "tracking-tight transition-[letter-spacing] duration-[300ms]",
              "group-hover:tracking-[-0.005em] truncate",
            )}
            data-testid="leftnav-workspace-name"
          >
            {workspaceName}
          </span>
        </div>
      </Link>

      {/* One-shot scan keyframe — defined inline so the rail file
          stays self-contained. */}
      <style>{`
        @keyframes leftnav-scan {
          0% { transform: translateX(-200%); }
          100% { transform: translateX(800%); }
        }
      `}</style>

      {/* Projects (primary IA — projects list IS the nav, no Section
          wrapper, no chevron, just a typography label + the list). */}
      <SectionLabel count={projectList.length}>Projects</SectionLabel>

      <nav className="relative flex-1 min-h-0 overflow-y-auto pb-1">
        {/* LayoutGroup unifies every motion.span with
            ``layoutId="leftnav-active-beam"`` across the rail, so when
            the user navigates between rows the beam glides smoothly
            from old to new position instead of cutting. Single shared
            element of design language. */}
        <LayoutGroup id="leftnav-rows">
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
        </LayoutGroup>
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
        <ModelsDockIcon active={isActive(path, "/models", false)} />
        <DockIcon
          label="System"
          to="/system"
          active={isActive(path, "/system", false)}
          icon={<Activity className="h-4 w-4" />}
          testId="leftnav-dock-system"
        />
        <DockIcon
          label="Settings"
          to="/settings/profile"
          active={isActive(path, "/settings", false)}
          icon={<Settings className="h-4 w-4" />}
          testId="leftnav-dock-settings"
        />
        <DockIcon
          label="Trash"
          to="/trash"
          active={isActive(path, "/trash", false)}
          icon={<Trash2 className="h-4 w-4" />}
          testId="leftnav-dock-trash"
        />
        {/* v3.24.11 — About moved into the user-footer dropdown only.
            Five icons in a 220 px rail crowded the dock; About is rare
            enough that the dropdown surface is the right home. */}
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
                <span className="relative shrink-0">
                  <span
                    className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-medium"
                    style={{
                      background: "var(--accent-bg)",
                      color: "var(--accent)",
                    }}
                  >
                    {userInitial}
                  </span>
                  {/* Silent activity ring — pulses while any
                      background batch is running. No badge / no count
                      / no toast; just a quiet "something's alive"
                      cue. Disappears when the queue empties. */}
                  {hasActiveJobs && (
                    <motion.span
                      aria-hidden
                      className="absolute -inset-[2px] rounded-full ring-2 ring-[color:var(--accent)]"
                      animate={{ opacity: [0.35, 0.85, 0.35] }}
                      transition={{
                        duration: 1.6,
                        repeat: Infinity,
                        ease: "easeInOut",
                      }}
                    />
                  )}
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

import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
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
import { projectsApi } from "@/api/projects";

/**
 * v3.0 C5 — soft cap on how many projects we list inline under the
 * "Annotate" section. Anything beyond this gets hidden behind a
 * "Show all (N)" link to /projects so the nav rail stays scannable.
 */
const ANNOTATE_PROJECTS_LIMIT = 8;

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
          {/* v2.9 P1-19 — "Datasets" was a duplicate route to /projects.
              Removed pending a dedicated Datasets surface (TODO: restore
              when datasets gain their own collection page). */}
          <NavItem
            label="All projects"
            to="/projects"
            active={path === "/projects"}
          />
          {/* v3.0 C5 — inline project list. Loading state shows a single
              muted row; errors render nothing extra (the user can still
              hit "All projects" above). */}
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
              <NavItem
                key={p.id}
                label={p.name}
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                active={path.startsWith("/projects/" + p.id)}
                testId={`leftnav-project-${p.id}`}
              />
            ))}
          {!projectsQ.isLoading && overflowCount > 0 && (
            <NavItem
              label={`Show all (${projectList.length})`}
              to="/projects"
              testId="leftnav-projects-show-all"
            />
          )}
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

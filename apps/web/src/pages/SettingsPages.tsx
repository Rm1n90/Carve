// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Copy,
  KeyRound,
  MoreVertical,
  Trash2,
  UserCog,
  UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Select";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/auth/store";
import { changePassword as authChangePassword } from "@/auth/api";
import { apiKeysApi, type ApiKey, type ApiKeyCreated } from "@/api/api_keys";
import {
  membersApi,
  type CreateRole,
  type Member,
  type Role,
} from "@/api/members";
import {
  invitesApi,
  projectMembersApi,
  type InviteListItem,
  type InviteRole,
  type ProjectMemberRole,
} from "@/api/invites";
import { projectsApi, type Project } from "@/api/projects";
import { workspaceApi } from "@/api/workspace";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";

const TABS: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: "/settings/profile", label: "Profile" },
  { to: "/settings/api-keys", label: "API Keys" },
  { to: "/settings/members", label: "Members", adminOnly: true },
  { to: "/settings/workspace", label: "Workspace" },
];

export function SettingsLayout({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const role = useAuth((s) => s.user?.role);

  return (
    <div className="grid gap-6 max-w-[1100px]">
      {/* v2.9 P1-16 — adopt the v2.8 editorial header pattern. */}
      <header className="grid gap-1">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          Settings
        </span>
        <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
          Settings
        </h1>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Manage your account, access, and workspace preferences.
        </p>
      </header>
      <div className="grid grid-cols-[200px_1fr] gap-8 items-start">
        <nav aria-label="Settings sections" className="grid gap-0.5">
          {TABS.filter((t) => !t.adminOnly || role === "admin").map((t) => {
            const active = path === t.to;
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "px-3 py-2 rounded-[var(--radius-sm)] text-[13px] tracking-tight",
                  "border-l-2 transition-colors",
                  active
                    ? "bg-[var(--bg-hover)] text-[color:var(--text-primary)] border-[var(--accent)] font-medium"
                    : "text-[color:var(--text-secondary)] border-transparent hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 grid gap-4">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------ Profile ------------------------------

export function SettingsProfilePage() {
  const user = useAuth((s) => s.user);
  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-5">
        <div>
          <h2 className="text-[16px] font-medium tracking-tight">Profile</h2>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
            Your sign-in identity. Email cannot be changed yet.
          </p>
        </div>
        <Input label="Email" value={user?.email ?? ""} readOnly disabled />
        <div>
          <label className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
            Role
          </label>
          <div className="mt-1.5">
            <Badge variant={user?.role === "admin" ? "accent" : "neutral"} size="md">
              {user?.role ?? "—"}
            </Badge>
          </div>
        </div>
      </Card>

      <ChangePasswordCard />
    </SettingsLayout>
  );
}

// Audit Bug 16 — self-service password change. The Settings card was
// hard-coded "Coming soon" with disabled inputs; now it submits to the new
// POST /auth/password endpoint and surfaces 401/422/429 responses as toasts.
const MIN_PASSWORD_LENGTH = 8;

function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  const m = useMutation({
    mutationFn: ({
      current_password,
      new_password,
    }: {
      current_password: string;
      new_password: string;
    }) => authChangePassword(current_password, new_password),
    onSuccess: () => {
      showToast("Password updated", { variant: "success" });
      setCurrent("");
      setNext("");
    },
    onError: (err: unknown) => {
      const status =
        (err as { response?: { status?: number } } | undefined)?.response?.status;
      if (status === 401) {
        showToast("Current password is wrong", { variant: "error" });
      } else if (status === 422) {
        showToast("New password must be at least 8 characters", {
          variant: "error",
        });
      } else if (status === 429) {
        showToast("Too many attempts. Please try again in a minute.", {
          variant: "error",
        });
      } else {
        showToast("Failed to change password", { variant: "error" });
      }
    },
  });

  const newTooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const canSubmit =
    current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && !m.isPending;

  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-3">
      <div>
        <h2 className="text-[16px] font-medium tracking-tight">Change password</h2>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Rotate your sign-in password. You'll stay signed in on this session.
        </p>
      </div>
      <form
        className="grid gap-3 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          m.mutate({ current_password: current, new_password: next });
        }}
      >
        <Input
          label="Current password"
          type="password"
          placeholder="••••••••"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          data-testid="change-password-current"
        />
        <div className="grid gap-1">
          <Input
            label="New password"
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={newTooShort || undefined}
            data-testid="change-password-new"
          />
          <p
            className={cn(
              "text-[11px] tracking-tight",
              newTooShort
                ? "text-[color:var(--danger)]"
                : "text-[color:var(--text-tertiary)]",
            )}
            data-testid="change-password-hint"
          >
            Min 8 characters
          </p>
        </div>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={!canSubmit}
            data-testid="change-password-submit"
          >
            {m.isPending ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------ API keys ------------------------------

export function SettingsApiKeysPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<ApiKeyCreated | null>(null);

  const keysQ = useQuery({ queryKey: ["api-keys"], queryFn: apiKeysApi.list });
  const createM = useMutation({
    mutationFn: () => apiKeysApi.create(name.trim()),
    onSuccess: (created) => {
      setRevealed(created);
      setName("");
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  const keys = keysQ.data ?? [];
  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-5">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-medium tracking-tight">API keys</h2>
            <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
              Personal access tokens for automation and CI integrations. Use the
              prefix <span className="font-mono text-[12px]">ck_</span> as the
              bearer token.
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            leftIcon={<KeyRound className="h-4 w-4" />}
            onClick={() => setCreating(true)}
          >
            New key
          </Button>
        </div>

        {keysQ.isLoading && (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>
        )}

        {!keysQ.isLoading && keys.length === 0 && (
          <p className="text-[13px] text-[color:var(--text-tertiary)] italic">
            No API keys yet.
          </p>
        )}

        {active.length > 0 && (
          <ul className="grid gap-2">
            {active.map((k) => (
              <ApiKeyRow key={k.id} k={k} onRevoke={() => revokeM.mutate(k.id)} />
            ))}
          </ul>
        )}

        {revoked.length > 0 && (
          <details>
            <summary className="text-[12px] text-[color:var(--text-tertiary)] cursor-pointer select-none">
              Show revoked ({revoked.length})
            </summary>
            <ul className="grid gap-2 mt-2 opacity-60">
              {revoked.map((k) => (
                <ApiKeyRow key={k.id} k={k} onRevoke={() => undefined} />
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give your token a memorable name. You'll see the secret value once.
            </DialogDescription>
          </DialogHeader>
          <Input
            label="Name"
            value={name}
            placeholder="e.g. CI pipeline"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createM.isPending}
              disabled={!name.trim()}
              onClick={() => createM.mutate()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token created — copy it now</DialogTitle>
            <DialogDescription>
              This is the only time the secret will be shown. Store it somewhere
              safe.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 grid gap-2">
            <div className="flex items-center gap-2 justify-between">
              <code
                data-testid="revealed-token"
                className="text-[12.5px] font-mono break-all text-[color:var(--text-primary)]"
              >
                {revealed?.token}
              </code>
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Copy className="h-3.5 w-3.5" />}
                onClick={() => {
                  if (revealed?.token) navigator.clipboard.writeText(revealed.token);
                }}
              >
                Copy
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="primary" onClick={() => setRevealed(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  );
}

function ApiKeyRow({ k, onRevoke }: { k: ApiKey; onRevoke: () => void }) {
  const created = new Date(k.created_at).toLocaleDateString();
  const confirm = useConfirm();
  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-4 py-3 flex items-center gap-4">
      <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent-bg)] text-[color:var(--accent)]">
        <KeyRound className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium tracking-tight truncate">{k.name}</p>
        <p className="text-[12px] text-[color:var(--text-tertiary)] font-mono">
          {k.prefix}
          <span className="ml-2 text-[11px]">created {created}</span>
        </p>
      </div>
      {k.revoked_at ? (
        <Badge variant="neutral">Revoked</Badge>
      ) : (
        <Button
          size="sm"
          variant="danger"
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={async () => {
            const ok = await confirm({
              title: "Revoke API key?",
              description:
                "Clients using this key will stop working immediately. This cannot be undone.",
              confirmLabel: "Revoke",
              variant: "danger",
            });
            if (ok) onRevoke();
          }}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

// ------------------------------ Members ------------------------------

const ROLES: Role[] = ["admin", "member", "viewer"];
// v3.0 Bug 14 — the new "Invite member" dialog only exposes admin and
// member. ``viewer`` remains in the role-edit dropdown for legacy data.
const INVITE_ROLES: CreateRole[] = ["admin", "member"];
const MIN_INVITE_PASSWORD_LENGTH = 8;

export function SettingsMembersPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const membersQ = useQuery({ queryKey: ["members"], queryFn: membersApi.list });
  const setRoleM = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      membersApi.setRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });
  const createM = useMutation({
    mutationFn: ({
      email,
      password,
      role,
    }: {
      email: string;
      password: string;
      role: CreateRole;
    }) => membersApi.create(email, password, role),
    onSuccess: (member) => {
      qc.invalidateQueries({ queryKey: ["members"] });
      showToast(`Created member ${member.email}`, { variant: "success" });
    },
    onError: (err: unknown) => {
      const status =
        (err as { response?: { status?: number } } | undefined)?.response?.status;
      if (status === 409) {
        showToast("That email is already taken", { variant: "error" });
      } else if (status === 403) {
        showToast("Only admins can invite members", { variant: "error" });
      } else if (status === 422) {
        showToast("Email or password is invalid", { variant: "error" });
      } else {
        showToast("Failed to create member", { variant: "error" });
      }
    },
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => membersApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members"] });
      showToast("Member removed", { variant: "success" });
    },
    onError: (err: unknown) => {
      const detail = (err as {
        response?: { data?: { detail?: string } };
      } | undefined)?.response?.data?.detail;
      if (detail === "cannot_delete_last_admin") {
        showToast("Can't remove the last admin", { variant: "error" });
      } else if (detail === "cannot_delete_self") {
        showToast("You can't remove yourself", { variant: "error" });
      } else {
        showToast("Failed to remove member", { variant: "error" });
      }
    },
  });

  const [inviting, setInviting] = useState(false);

  const members = membersQ.data ?? [];
  const isAdmin = me?.role === "admin";
  // Track the active admin count locally so we can hide the delete option
  // on the last admin (defence-in-depth — server still enforces this).
  const adminCount = members.filter((m) => m.role === "admin").length;

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-medium tracking-tight">Members</h2>
            <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
              Everyone with access to this workspace.
            </p>
          </div>
          {isAdmin ? (
            <Button
              variant="primary"
              size="md"
              leftIcon={<UserPlus className="h-4 w-4" />}
              onClick={() => setInviting(true)}
              data-testid="members-invite-button"
            >
              Invite member
            </Button>
          ) : (
            <Badge variant="neutral">
              View-only · admin required to change roles
            </Badge>
          )}
        </div>

        {membersQ.isLoading ? (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>
        ) : (
          <ul className="grid gap-2" data-testid="members-list">
            {members.map((m) => {
              const isMe = m.id === me?.id;
              const isLastAdmin = m.role === "admin" && adminCount <= 1;
              return (
                <MemberRow
                  key={m.id}
                  m={m}
                  isMe={isMe}
                  isAdmin={isAdmin}
                  canDelete={isAdmin && !isMe && !isLastAdmin}
                  onChangeRole={(role) => setRoleM.mutate({ id: m.id, role })}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: `Delete ${m.email}?`,
                      description:
                        "They will lose access immediately. This cannot be undone.",
                      confirmLabel: "Delete",
                      variant: "danger",
                    });
                    if (ok) deleteM.mutate(m.id);
                  }}
                />
              );
            })}
          </ul>
        )}
      </Card>

      <InviteMemberDialog
        open={inviting}
        onOpenChange={setInviting}
        pending={createM.isPending}
        onSubmit={(values) =>
          createM.mutate(values, {
            onSuccess: () => setInviting(false),
          })
        }
      />

      <ProjectMembersSection />
    </SettingsLayout>
  );
}

// ---------------------- Per-project members (Plan-13 Phase 7 Task 4) -----

const PROJECT_INVITE_ROLES: InviteRole[] = ["admin", "member", "viewer"];

function ProjectMembersSection() {
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: projectsApi.list,
  });
  const projects = projectsQ.data ?? [];
  if (!projects.length) return null;
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-4">
      <div>
        <h2 className="text-[16px] font-medium tracking-tight">
          Per-project members
        </h2>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Manage who can access each project. Invite by email; the link
          you receive can be shared with the recipient.
        </p>
      </div>
      <ul className="grid gap-6" data-testid="project-members-list">
        {projects.map((p) => (
          <ProjectMembersRow key={p.id} project={p} />
        ))}
      </ul>
    </Card>
  );
}

function ProjectMembersRow({ project }: { project: Project }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  const invitesQ = useQuery({
    queryKey: ["project-invites", project.id],
    queryFn: () => invitesApi.list(project.id),
  });
  const createInviteM = useMutation({
    mutationFn: () => invitesApi.create(project.id, email.trim(), role),
    onSuccess: (created) => {
      const link = `${window.location.origin}/invite/${created.token}`;
      setCreatedLink(link);
      setEmail("");
      invitesQ.refetch();
      showToast("Invitation created", { variant: "success" });
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 409) {
        showToast("Already a member or invited", { variant: "error" });
      } else if (status === 403) {
        showToast("Only owners or admins can invite", { variant: "error" });
      } else {
        showToast("Failed to create invitation", { variant: "error" });
      }
    },
  });
  const revokeM = useMutation({
    mutationFn: (inviteId: string) => invitesApi.revoke(project.id, inviteId),
    onSuccess: () => {
      invitesQ.refetch();
      showToast("Invitation revoked", { variant: "success" });
    },
  });

  const invites = invitesQ.data ?? [];

  return (
    <li className="grid gap-3" data-testid={`project-row-${project.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="text-[14px] font-medium tracking-tight">
            {project.name}
          </span>
          <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[color:var(--text-tertiary)]">
            Project
          </span>
        </div>
      </div>

      <form
        className="grid grid-cols-[1fr_auto_auto] gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          createInviteM.mutate();
        }}
      >
        <Input
          label="Invite email"
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid={`project-${project.id}-invite-email`}
        />
        <div className="grid gap-1.5">
          <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
            Role
          </span>
          <Select
            value={role}
            onValueChange={(v) => setRole(v as InviteRole)}
          >
            <Select.Trigger
              aria-label="Invite role"
              data-testid={`project-${project.id}-invite-role`}
            >
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {PROJECT_INVITE_ROLES.map((r) => (
                <Select.Item key={r} value={r}>
                  {r}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={createInviteM.isPending}
          data-testid={`project-${project.id}-invite-submit`}
        >
          Invite
        </Button>
      </form>

      {createdLink && (
        <div
          className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--surface-1)] px-3 py-2"
          data-testid={`project-${project.id}-invite-link`}
        >
          <code className="text-[12px] font-mono break-all flex-1">
            {createdLink}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            leftIcon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => {
              navigator.clipboard?.writeText(createdLink);
              showToast("Copied", { variant: "success" });
            }}
          >
            Copy
          </Button>
        </div>
      )}

      {invites.length > 0 && (
        <ul className="grid gap-1.5" data-testid={`project-${project.id}-pending`}>
          {invites.map((inv) => (
            <PendingInviteRow
              key={inv.id}
              invite={inv}
              onRevoke={() => revokeM.mutate(inv.id)}
              pending={revokeM.isPending}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PendingInviteRow({
  invite,
  onRevoke,
  pending,
}: {
  invite: InviteListItem;
  onRevoke: () => void;
  pending: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 text-[13px]">
      <div className="flex items-center gap-2">
        <Badge variant="neutral">{invite.role}</Badge>
        <span>{invite.email}</span>
        <span className="text-[11px] text-[color:var(--text-tertiary)]">
          pending
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={pending}
        onClick={onRevoke}
        data-testid={`revoke-invite-${invite.id}`}
      >
        Revoke
      </Button>
    </li>
  );
}

// Currently unused but exported for future role-change UI integration.
export const PROJECT_MEMBER_ROLE_OPTIONS: ProjectMemberRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

// Re-export for tests / future UI hookups.
export const __projectMembersInternals = {
  setRole: projectMembersApi.setRole,
  remove: projectMembersApi.remove,
};

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (values: {
    email: string;
    password: string;
    role: CreateRole;
  }) => void;
}

function InviteMemberDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<CreateRole>("member");

  const trimmedEmail = email.trim();
  const passwordTooShort =
    password.length > 0 && password.length < MIN_INVITE_PASSWORD_LENGTH;
  const canSubmit =
    trimmedEmail.length > 0 &&
    password.length >= MIN_INVITE_PASSWORD_LENGTH &&
    !pending;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setEmail("");
      setPassword("");
      setRole("member");
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Create an account with an initial password. They can change it
            later from Settings → Profile.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            onSubmit({ email: trimmedEmail, password, role });
          }}
        >
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="invite-member-email"
            autoFocus
          />
          <div className="grid gap-1">
            <Input
              label="Initial password"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={passwordTooShort || undefined}
              data-testid="invite-member-password"
            />
            <p
              className={cn(
                "text-[11px] tracking-tight",
                passwordTooShort
                  ? "text-[color:var(--danger)]"
                  : "text-[color:var(--text-tertiary)]",
              )}
            >
              Min 8 characters. Share securely; they can rotate it on first
              sign-in.
            </p>
          </div>
          <div className="grid gap-1.5">
            <label
              className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium"
              htmlFor="invite-member-role-trigger"
            >
              Role
            </label>
            <Select value={role} onValueChange={(v) => setRole(v as CreateRole)}>
              <Select.Trigger
                aria-label="Role"
                data-testid="invite-member-role-trigger"
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {INVITE_ROLES.map((r) => (
                  <Select.Item
                    key={r}
                    value={r}
                    data-testid={`invite-member-role-${r}`}
                  >
                    {r}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              disabled={!canSubmit}
              data-testid="invite-member-submit"
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  m,
  isMe,
  isAdmin,
  canDelete,
  onChangeRole,
  onDelete,
}: {
  m: Member;
  isMe: boolean;
  isAdmin: boolean;
  canDelete: boolean;
  onChangeRole: (r: Role) => void;
  onDelete: () => void;
}) {
  const initial = m.email[0]?.toUpperCase() ?? "?";
  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-4 py-2.5 flex items-center gap-3">
      <span className="grid h-7 w-7 place-items-center rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] text-[12px] font-medium">
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] truncate">
          {m.email}
          {isMe && (
            <span className="ml-2 text-[11px] text-[color:var(--text-tertiary)]">
              (you)
            </span>
          )}
        </p>
      </div>
      {isAdmin && !isMe ? (
        <select
          aria-label={`Role for ${m.email}`}
          value={m.role}
          onChange={(e) => onChangeRole(e.target.value as Role)}
          className={cn(
            "h-8 px-2 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
            "text-[12.5px] tracking-tight",
            "focus:outline-none focus:border-[var(--accent)]",
          )}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      ) : (
        <Badge variant={m.role === "admin" ? "accent" : "neutral"}>
          <UserCog className="h-3 w-3" /> {m.role}
        </Badge>
      )}
      {canDelete && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${m.email}`}
              data-testid={`member-menu-trigger-${m.id}`}
              className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]"
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-[1000] min-w-[200px] rounded-[var(--radius-md)] glass-surface-strong p-1"
            >
              <DropdownMenu.Item
                data-testid={`member-menu-delete-${m.id}`}
                onSelect={() => onDelete()}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12.5px] outline-none",
                  "data-[highlighted]:bg-[var(--bg-hover)] cursor-pointer",
                  "text-[color:var(--danger)]",
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete member</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </li>
  );
}

// ------------------------------ Workspace ------------------------------

// v3.1 Bug 6 — replaces the prior "Coming soon" placeholder. The workspace
// is now a real singleton row backed by ``GET /workspace`` and
// ``PATCH /workspace``; admins can rename it and edit a description.
const WORKSPACE_NAME_MAX = 120;
const WORKSPACE_DESCRIPTION_MAX = 2000;

export function SettingsWorkspacePage() {
  const role = useAuth((s) => s.user?.role);
  const isAdmin = role === "admin";
  const qc = useQueryClient();

  const wsQ = useQuery({
    queryKey: ["workspace"],
    queryFn: workspaceApi.get,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Sync local form state from server data when it (re)loads. Only resets
  // on identity change so the user's in-flight edits survive a background
  // refetch that returns the same payload.
  const wsId = wsQ.data?.id;
  useEffect(() => {
    if (wsQ.data) {
      setName(wsQ.data.name);
      setDescription(wsQ.data.description ?? "");
    }
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({
    mutationFn: (patch: { name?: string; description?: string }) =>
      workspaceApi.update(patch),
    onSuccess: () => {
      showToast("Workspace updated", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (err: unknown) => {
      const status =
        (err as { response?: { status?: number } } | undefined)?.response
          ?.status;
      if (status === 403) {
        showToast("Only admins can edit the workspace", { variant: "error" });
      } else if (status === 422) {
        showToast("Invalid workspace details", { variant: "error" });
      } else {
        showToast("Failed to update workspace", { variant: "error" });
      }
    },
  });

  const trimmedName = name.trim();
  const serverName = wsQ.data?.name ?? "";
  const serverDescription = wsQ.data?.description ?? "";
  const dirty =
    trimmedName !== serverName.trim() || description !== serverDescription;
  const canSubmit =
    isAdmin &&
    trimmedName.length > 0 &&
    trimmedName.length <= WORKSPACE_NAME_MAX &&
    description.length <= WORKSPACE_DESCRIPTION_MAX &&
    dirty &&
    !m.isPending;

  const created = wsQ.data?.created_at
    ? new Date(wsQ.data.created_at).toLocaleDateString()
    : null;

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-5">
        <div>
          <h2 className="text-[16px] font-medium tracking-tight">Workspace</h2>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
            One workspace per install. Admins can rename it and add a
            description that surfaces in member-facing UI.
          </p>
        </div>

        {wsQ.isLoading && (
          <p
            className="text-[13px] text-[color:var(--text-tertiary)]"
            data-testid="workspace-loading"
          >
            Loading…
          </p>
        )}

        {wsQ.data && (
          <form
            className="grid gap-4 max-w-xl"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              const patch: { name?: string; description?: string } = {};
              if (trimmedName !== serverName.trim()) patch.name = trimmedName;
              if (description !== serverDescription)
                patch.description = description;
              m.mutate(patch);
            }}
          >
            <Input
              label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={WORKSPACE_NAME_MAX}
              required
              disabled={!isAdmin}
              hint={
                isAdmin
                  ? `Up to ${WORKSPACE_NAME_MAX} characters.`
                  : undefined
              }
              data-testid="workspace-name"
            />
            <div className="grid gap-1.5">
              <label
                htmlFor="workspace-description"
                className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium"
              >
                Description
                <span className="text-[color:var(--text-tertiary)] font-normal">
                  {" "}
                  (optional)
                </span>
              </label>
              <textarea
                id="workspace-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={WORKSPACE_DESCRIPTION_MAX}
                disabled={!isAdmin}
                rows={4}
                className={cn(
                  "w-full rounded-[var(--radius-md)]",
                  "bg-[var(--bg-elev)] text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
                  "border border-[var(--border-subtle)]",
                  "px-3 py-2 text-[13px] leading-[1.55] resize-y min-h-[88px]",
                  "transition-colors duration-150",
                  "hover:border-[var(--border-strong)]",
                  "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(99,102,241,0.18)]",
                  "disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[var(--bg-hover)]",
                )}
                placeholder={
                  isAdmin
                    ? "What this workspace is for, who uses it, anything teammates should know."
                    : ""
                }
                data-testid="workspace-description"
              />
              <p className="text-[12px] text-[color:var(--text-tertiary)] flex justify-between">
                <span>
                  {isAdmin
                    ? "Plain text, shown to teammates."
                    : "Only admins can edit"}
                </span>
                <span>
                  {description.length}/{WORKSPACE_DESCRIPTION_MAX}
                </span>
              </p>
            </div>

            {isAdmin ? (
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!canSubmit}
                  data-testid="workspace-submit"
                >
                  {m.isPending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            ) : (
              <p
                className="text-[12px] text-[color:var(--text-tertiary)] italic"
                data-testid="workspace-readonly-note"
              >
                Only admins can edit the workspace.
              </p>
            )}
          </form>
        )}
      </Card>

      {wsQ.data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card variant="surface" radius="lg" className="p-5 grid gap-1">
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
              Members
            </span>
            <Link
              to="/settings/members"
              className="text-[28px] tracking-tight font-light text-[color:var(--text-primary)] hover:text-[color:var(--accent)] transition-colors"
              data-testid="workspace-members-link"
            >
              {wsQ.data.members_count}
            </Link>
            <span className="text-[12px] text-[color:var(--text-secondary)]">
              Active members. Manage in Settings → Members.
            </span>
          </Card>
          <Card variant="surface" radius="lg" className="p-5 grid gap-1">
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
              Created
            </span>
            <span
              className="text-[28px] tracking-tight font-light text-[color:var(--text-primary)]"
              data-testid="workspace-created"
            >
              {created ?? "—"}
            </span>
            <span className="text-[12px] text-[color:var(--text-secondary)]">
              Workspace creation date.
            </span>
          </Card>
        </div>
      )}
    </SettingsLayout>
  );
}

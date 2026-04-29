import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2, UserCog } from "lucide-react";
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
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/auth/store";
import { changePassword as authChangePassword } from "@/auth/api";
import { apiKeysApi, type ApiKey, type ApiKeyCreated } from "@/api/api_keys";
import { membersApi, type Member, type Role } from "@/api/members";
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

export function SettingsMembersPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const membersQ = useQuery({ queryKey: ["members"], queryFn: membersApi.list });
  const setRoleM = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      membersApi.setRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });

  const members = membersQ.data ?? [];

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-[16px] font-medium tracking-tight">Members</h2>
            <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
              Everyone with access to this workspace.
            </p>
          </div>
          {me?.role !== "admin" && (
            <Badge variant="neutral">View-only · admin required to change roles</Badge>
          )}
        </div>

        {membersQ.isLoading ? (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>
        ) : (
          <ul className="grid gap-2" data-testid="members-list">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                m={m}
                isMe={m.id === me?.id}
                canEdit={me?.role === "admin"}
                onChangeRole={(role) => setRoleM.mutate({ id: m.id, role })}
              />
            ))}
          </ul>
        )}

        <Card variant="sunken" radius="md" className="p-4">
          <p className="text-[12.5px] text-[color:var(--text-secondary)]">
            <strong>Inviting users:</strong> sign-up is restricted after the
            first admin is created. To add a new member, ask an existing admin
            to register the account at <code className="font-mono">/register</code>{" "}
            while authenticated.
          </p>
        </Card>
      </Card>
    </SettingsLayout>
  );
}

function MemberRow({
  m,
  isMe,
  canEdit,
  onChangeRole,
}: {
  m: Member;
  isMe: boolean;
  canEdit: boolean;
  onChangeRole: (r: Role) => void;
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
      {canEdit && !isMe ? (
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
    </li>
  );
}

// ------------------------------ Workspace ------------------------------

export function SettingsWorkspacePage() {
  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[16px] font-medium tracking-tight">Workspace</h2>
          <Badge variant="neutral">Coming soon</Badge>
        </div>
        <p className="text-[13px] text-[color:var(--text-secondary)]">
          Workspace-level configuration (name, default task kind, retention)
          will be configurable here in a later release. For now, the workspace
          is a singleton driven by environment variables on the API service.
        </p>
        <div className="grid gap-3 max-w-md opacity-60 pointer-events-none">
          <Input label="Workspace name" value="Carve" disabled />
          <Input label="Default task kind" value="image" disabled />
        </div>
      </Card>
    </SettingsLayout>
  );
}

// Armin Mehri — mehri.armin@gmail.com
/**
 * Settings → Activity log (superadmin only): everything recorded across
 * the workspace — sign-ins, account changes, configuration, deletions,
 * exports — newest first, filterable by kind and by person.
 */
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { auditApi, type AuditFilter } from "@/api/audit";
import { membersApi } from "@/api/members";
import { SettingsLayout } from "@/pages/SettingsPages";

const KINDS: { id: string; label: string; filter: AuditFilter }[] = [
  { id: "all", label: "Everything", filter: {} },
  { id: "sign-ins", label: "Sign-ins", filter: { action: "user.signed_in" } },
  {
    id: "accounts",
    label: "Accounts: roles, passwords, blocks",
    filter: {
      action: [
        "user.created",
        "user.deleted",
        "user.restored",
        "user.role_changed",
        "user.email_changed",
        "user.password_reset",
        "user.blocked",
        "user.unblocked",
        "user.sessions_revoked",
        "api_key.revoked",
      ].join(","),
    },
  },
  {
    id: "configuration",
    label: "Configuration and backups",
    filter: { action: "setting.updated,setting.cleared,backup.requested" },
  },
  { id: "projects", label: "Projects and project access", filter: { action_prefix: "project" } },
  {
    id: "deletions",
    label: "Deletions and moves",
    filter: { action: "task.deleted,class.deleted,assets.deleted,assets.moved" },
  },
  { id: "exports", label: "Exports", filter: { action_prefix: "export." } },
  { id: "training", label: "Training", filter: { action_prefix: "retrain." } },
  {
    id: "review",
    label: "Review",
    filter: { action: "annotation.accepted,annotation.rejected,annotations.batch_reviewed" },
  },
];

const SELECT =
  "h-9 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2.5 text-[13px] text-[color:var(--text-primary)]";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SettingsActivityPage() {
  const [kind, setKind] = useState("all");
  const [person, setPerson] = useState("");
  const membersQ = useQuery({ queryKey: ["members"], queryFn: membersApi.list });
  const filter: AuditFilter = {
    ...(KINDS.find((k) => k.id === kind)?.filter ?? {}),
    ...(person ? { person } : {}),
  };
  const q = useInfiniteQuery({
    queryKey: ["audit", "workspace", filter],
    queryFn: ({ pageParam }) => auditApi.workspace(filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div>
          <h2 className="text-[16px] font-semibold tracking-tight">Activity log</h2>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1 max-w-[720px]">
            What happened across the workspace, newest first: sign-ins, account changes,
            configuration, deletions, exports and more. Only the superadmin sees this page.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            What
            <select
              aria-label="What"
              className={SELECT}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-[color:var(--text-secondary)]">
            Who
            <select
              aria-label="Who"
              className={SELECT}
              value={person}
              onChange={(e) => setPerson(e.target.value)}
            >
              <option value="">Everyone</option>
              {(membersQ.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
                </option>
              ))}
            </select>
          </label>
        </div>

        {q.isLoading ? (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>
        ) : q.isError ? (
          <p className="text-[13px] text-[color:var(--danger)]">Could not load the activity log.</p>
        ) : items.length === 0 ? (
          <p className="text-[13px] text-[color:var(--text-tertiary)]">Nothing recorded.</p>
        ) : (
          <ul className="grid gap-1.5" data-testid="activity-list">
            {items.map((ev) => (
              <li
                key={ev.id}
                className="grid grid-cols-[150px_1fr] gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-3 py-2"
              >
                <span className="text-[12px] text-[color:var(--text-tertiary)] tabular-nums">
                  {formatWhen(ev.occurred_at)}
                </span>
                <div className="min-w-0 grid gap-0.5">
                  <p className="text-[13px] break-words">{ev.summary}</p>
                  <p className="text-[11px] text-[color:var(--text-tertiary)]">
                    {ev.actor_email ?? (ev.actor_id ? "removed account" : "Carve")}
                    {ev.project_name ? ` · ${ev.project_name}` : ""}
                    {" · "}
                    <span className="font-mono">{ev.action}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div>
            <Button
              variant="secondary"
              size="sm"
              loading={q.isFetchingNextPage}
              onClick={() => q.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        )}
      </Card>
    </SettingsLayout>
  );
}

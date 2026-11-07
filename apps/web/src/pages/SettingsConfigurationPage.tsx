// Armin Mehri — mehri.armin@gmail.com
/**
 * Settings → Configuration (superadmin only): provider API keys and the
 * other settings that used to live only in `.env`. A value saved here
 * takes precedence over `.env` and reaches the API and the worker within
 * seconds, without a restart. Secrets are write-only: the page shows
 * their last four characters, never the key.
 */
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import {
  appSettingsApi,
  type AppSetting,
  type AppSettingsListing,
  type KeyTestResult,
} from "@/api/appSettings";
import { backupsApi, type BackupsListing } from "@/api/backups";
import { showToast } from "@/lib/toast";
import { SettingsLayout } from "@/pages/SettingsPages";

const QUERY_KEY = ["admin-settings"];

function errorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { message?: string } } } | undefined)?.response
    ?.data;
  return data?.message ?? fallback;
}

function gib(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return g >= 1 ? `${+g.toFixed(2)} GiB` : `${+(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function SourceBadge({ s }: { s: AppSetting }) {
  if (s.unreadable) return <Badge variant="danger">Enter again</Badge>;
  if (s.source === "app") return <Badge variant="accent">Set here</Badge>;
  if (s.source === "env") return <Badge variant="neutral">From .env</Badge>;
  if (s.kind === "secret") return <Badge variant="warning">Not set</Badge>;
  return <Badge variant="ghost">Default</Badge>;
}

function SettingRow({ s }: { s: AppSetting }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const isSecret = s.kind === "secret";
  const shown = s.value === null || s.value === undefined ? "" : String(s.value);
  const [draft, setDraft] = useState(isSecret ? "" : shown);
  const [test, setTest] = useState<KeyTestResult | null>(null);

  // A refreshed listing resets the field to the value now in use.
  useEffect(() => {
    setDraft(isSecret ? "" : shown);
  }, [shown, s.hint, s.source]); // eslint-disable-line react-hooks/exhaustive-deps

  const onListing = (listing: AppSettingsListing) => qc.setQueryData(QUERY_KEY, listing);

  const save = useMutation({
    mutationFn: (value: unknown) => appSettingsApi.save(s.key, value),
    onSuccess: (listing) => {
      onListing(listing);
      setTest(null);
      showToast(`${s.label} saved`, { variant: "success" });
    },
    onError: (err) => showToast(errorText(err, `Could not save ${s.label}`), { variant: "error" }),
  });
  const clear = useMutation({
    mutationFn: () => appSettingsApi.clear(s.key),
    onSuccess: (listing) => {
      onListing(listing);
      setTest(null);
      showToast(`${s.label} cleared`, { variant: "success" });
    },
    onError: (err) => showToast(errorText(err, `Could not clear ${s.label}`), { variant: "error" }),
  });
  const check = useMutation({
    mutationFn: () => appSettingsApi.test(s.key, draft.trim() || undefined),
    onSuccess: setTest,
    onError: (err) => setTest({ ok: false, message: errorText(err, "The test failed.") }),
  });

  const busy = save.isPending || clear.isPending;
  const dirty = isSecret ? draft.trim() !== "" : draft.trim() !== shown;
  const canSave = dirty && !busy && (draft.trim() !== "" || s.allow_empty);

  const onClear = async () => {
    const fallback =
      isSecret
        ? s.env_hint
          ? `the .env key (${s.env_hint})`
          : "no key at all"
        : s.env_set
          ? "the .env value"
          : "the default";
    const ok = await confirm({
      title: `Clear ${s.label}?`,
      description: `The app goes back to ${fallback}.`,
      confirmLabel: "Clear",
      variant: "danger",
    });
    if (ok) clear.mutate();
  };

  const control =
    s.kind === "choice" ? (
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={s.label}
          className="h-9 min-w-[200px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2.5 text-[13px] text-[color:var(--text-primary)]"
          value={shown}
          disabled={busy}
          onChange={(e) => save.mutate(e.target.value)}
        >
          {!s.options.includes(shown) && <option value={shown}>{shown || "—"}</option>}
          {s.options.map((o, i) => (
            <option key={o} value={o}>
              {s.option_labels[i] ?? o}
            </option>
          ))}
        </select>
        {s.source === "app" && (
          <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    ) : s.kind === "bool" ? (
      <div className="flex items-center gap-3">
        <Switch
          checked={s.value === true}
          disabled={busy}
          onChange={(e) => save.mutate(e.target.checked)}
          aria-label={s.label}
        />
        {s.source === "app" && (
          <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    ) : (
      <form
        className="flex flex-wrap items-start gap-2"
        // The server checks every value and says why one is refused.
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate(draft);
        }}
      >
        <div className="min-w-[260px] flex-1 max-w-[460px]">
          <Input
            aria-label={s.label}
            type={isSecret ? "password" : s.kind === "int" || s.kind === "float" ? "number" : "text"}
            autoComplete={isSecret ? "new-password" : "off"}
            spellCheck={false}
            value={draft}
            min={s.minimum ?? undefined}
            max={s.maximum ?? undefined}
            step={s.kind === "float" ? "any" : undefined}
            placeholder={
              isSecret
                ? s.hint
                  ? `In use: ${s.hint}. Paste a new key to replace it`
                  : "Paste the key"
                : s.kind === "url"
                  ? "https://"
                  : undefined
            }
            hint={
              s.unit === "bytes" && draft.trim() !== "" && !Number.isNaN(Number(draft))
                ? `= ${gib(Number(draft))}`
                : s.unit ?? undefined
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setTest(null);
            }}
          />
        </div>
        <Button type="submit" variant="primary" size="md" disabled={!canSave}>
          Save
        </Button>
        {s.testable && (
          <Button
            type="button"
            size="md"
            disabled={check.isPending || (!draft.trim() && !s.hint)}
            onClick={() => check.mutate()}
          >
            {check.isPending ? "Testing…" : draft.trim() ? "Test this key" : "Test"}
          </Button>
        )}
        {s.source === "app" && (
          <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onClear}>
            Clear
          </Button>
        )}
      </form>
    );

  return (
    <div className="grid gap-2 py-4 border-t border-[var(--border-subtle)] first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-medium tracking-tight">{s.label}</span>
        <SourceBadge s={s} />
        <span className="font-mono text-[10.5px] text-[color:var(--text-tertiary)]">{s.key}</span>
      </div>
      <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[680px]">{s.help}</p>
      {s.links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-2.5 py-1 text-[12px] text-[color:var(--accent)] hover:bg-[var(--bg-hover)]"
            >
              {l.label}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ))}
        </div>
      )}
      {s.unreadable && (
        <p className="text-[12px] text-[color:var(--danger)]">
          The saved value can no longer be read (PASSWORD_PEPPER changed?), so the{" "}
          {s.env_set ? ".env value" : "default"} is in use. Enter it again.
        </p>
      )}
      {control}
      {test && (
        <p
          className="text-[12px]"
          style={{ color: test.ok ? "var(--success)" : "var(--danger)" }}
          role="status"
        >
          {test.message}
        </p>
      )}
      <p className="text-[11.5px] text-[color:var(--text-tertiary)]">
        {s.source === "app" && s.updated_at && (
          <>
            Saved {new Date(s.updated_at).toLocaleString()}
            {s.updated_by ? ` by ${s.updated_by}` : ""}.{" "}
          </>
        )}
        {s.source === "app" && isSecret && s.env_hint && (
          <>.env has another key ({s.env_hint}); it is used again if you clear this one.</>
        )}
        {s.source === "app" && !isSecret && s.env_set && (
          <>.env also sets it; that value is used again if you clear this one.</>
        )}
      </p>
    </div>
  );
}

const APPLIES: Record<string, string> = {
  api: "Applies within seconds.",
  model: "Read by the model service when it starts: restart it to apply a change.",
  backup: "Applies before the next backup (checked every 30 seconds).",
};

function ModelServiceBar({ listing }: { listing: AppSettingsListing }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const status = listing.services.model;
  const restart = useMutation({
    mutationFn: appSettingsApi.restartModel,
    onSuccess: () => {
      showToast("The model service is restarting", { variant: "success" });
      // It is back in well under a minute; watch for it.
      let tries = 0;
      const poll = window.setInterval(async () => {
        tries += 1;
        const next = await appSettingsApi.list().catch(() => null);
        if (next) qc.setQueryData(QUERY_KEY, next);
        if ((next?.services.model.reachable && !next.services.model.pending_restart) || tries > 40) {
          window.clearInterval(poll);
        }
      }, 3000);
    },
    onError: (err) =>
      showToast(errorText(err, "Could not restart the model service"), { variant: "error" }),
  });
  const text = !status.reachable
    ? "The model service is not running."
    : status.pending_restart
      ? "Saved changes are waiting: the model service started before them."
      : "The model service runs with these settings.";
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2">
      <span
        className="text-[12.5px]"
        style={{ color: status.pending_restart ? "var(--warning)" : "var(--text-secondary)" }}
        role="status"
      >
        {text}
      </span>
      <Button
        type="button"
        size="sm"
        variant={status.pending_restart ? "primary" : "secondary"}
        disabled={!status.reachable || restart.isPending}
        onClick={async () => {
          const ok = await confirm({
            title: "Restart the model service?",
            description:
              "SAM and YOLO stop for about a minute while it restarts and loads its models. " +
              "Requests in progress are retried.",
            confirmLabel: "Restart",
          });
          if (ok) restart.mutate();
        }}
      >
        {restart.isPending ? "Restarting…" : "Restart model service"}
      </Button>
    </div>
  );
}

/** The dumps on disk and "Back up now" (Database backups section). */
function BackupsPanel() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ["admin-backups"],
    queryFn: backupsApi.list,
    // Follow a requested or running dump until it is on disk.
    refetchInterval: (query) => {
      const d = query.state.data as BackupsListing | undefined;
      return d && (d.running || d.requested_at) ? 5000 : false;
    },
  });
  const run = useMutation({
    mutationFn: backupsApi.run,
    onSuccess: (d) => qc.setQueryData(["admin-backups"], d),
    onError: () => showToast("Could not request a backup", { variant: "error" }),
  });
  const d = q.data;
  if (!d) return null;
  if (!d.available) {
    return (
      <p className="text-[12.5px] text-[color:var(--text-tertiary)] mb-4">
        Carve cannot see the backups folder, so the dumps are not listed here.
      </p>
    );
  }
  const latest = d.files[0];
  const stale =
    d.requested_at !== null &&
    !d.running &&
    Date.now() - new Date(d.requested_at).getTime() > 2 * 60_000;
  const shown = showAll ? d.files : d.files.slice(0, 5);
  return (
    <div
      className="mb-4 grid gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] px-4 py-3"
      data-testid="backups-panel"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[12.5px] text-[color:var(--text-secondary)] flex-1 min-w-[240px]">
          {d.running
            ? "A backup is being written now. It takes a few minutes."
            : stale
              ? "Requested, but the backup service has not started it. Is db-backup running?"
              : d.requested_at
                ? "Requested: the backup service starts it within 30 seconds."
                : latest
                  ? `Latest backup ${new Date(latest.created_at).toLocaleString()} (${gib(latest.size_bytes)}), ${d.files.length} kept.`
                  : "No backups yet."}
        </p>
        <Button
          variant="secondary"
          size="sm"
          loading={run.isPending}
          disabled={d.running || d.requested_at !== null}
          onClick={() => run.mutate()}
        >
          Back up now
        </Button>
      </div>
      <p className="text-[11.5px] text-[color:var(--text-tertiary)]">
        A backup made now counts as one of the daily copies kept. Backups hold the database only
        (annotations, classes, tasks, users), not the images. Restoring is done on the server; see
        the admin guide.
      </p>
      {d.files.length > 0 && (
        <ul className="grid gap-0.5 font-mono text-[11.5px] text-[color:var(--text-secondary)]">
          {shown.map((f) => (
            <li key={`${f.tier}/${f.name}`} className="flex gap-3">
              <span className="w-[64px] text-[color:var(--text-tertiary)]">{f.tier}</span>
              <span className="flex-1 truncate">{f.name}</span>
              <span className="tabular-nums">{gib(f.size_bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {d.files.length > 5 && (
        <button
          type="button"
          className="justify-self-start text-[12px] text-[color:var(--accent)] hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all ${d.files.length}`}
        </button>
      )}
    </div>
  );
}

/** Which settings each tab shows (by the API's group names). A group
 * not listed here lands on "Other", so a new setting is never hidden. */
const TABS: { id: string; label: string; groups: string[]; intro?: string }[] = [
  {
    id: "providers",
    label: "AI providers",
    groups: ["Logo AI providers"],
    intro:
      "The keys Logo AI runs the hosted models with. Each provider charges its own account: " +
      "make a key on the provider's page (the button under each key), paste it here, Save, " +
      "then Test. You need only the providers you want to use.",
  },
  { id: "logo-ai", label: "Logo AI", groups: ["Logo AI"] },
  {
    id: "access",
    label: "Member access",
    groups: ["Member access"],
    intro:
      "Which AI tools members (and viewers) may use. Admins always may. \"On tasks opened " +
      "for them\" follows the AI tools for members switch in each task's ⋮ menu; \"every " +
      "task\" opens the tool on every task they can open.",
  },
  { id: "sign-in", label: "Sign-in", groups: ["Sign-in", "Single sign-on"] },
  { id: "model", label: "Model service", groups: ["Model service (SAM, YOLO)"] },
  { id: "uploads", label: "Uploads & addresses", groups: ["Uploads and models", "Addresses"] },
  { id: "backups", label: "Backups", groups: ["Database backups"] },
];
const TAB_KEY = "carve.configuration.tab";

function readTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? TABS[0].id;
  } catch {
    return TABS[0].id;
  }
}

export function SettingsConfigurationPage() {
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: appSettingsApi.list });
  const [tab, setTab] = useState(readTab);
  const groups: [string, AppSetting[]][] = [];
  for (const s of q.data?.settings ?? []) {
    const g = groups.find(([name]) => name === s.group);
    if (g) g[1].push(s);
    else groups.push([s.group, [s]]);
  }
  const known = new Set(TABS.flatMap((t) => t.groups));
  const other = groups.filter(([name]) => !known.has(name));
  const tabs = [
    ...TABS,
    ...(other.length ? [{ id: "other", label: "Other", groups: other.map(([n]) => n) }] : []),
    { id: "locked", label: ".env only", groups: [] as string[] },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const onTab = (id: string) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* remembering the tab is a convenience only */
    }
  };

  return (
    <SettingsLayout>
      <Card variant="surface" radius="lg" className="p-6 grid gap-2">
        <h2 className="text-[16px] font-semibold tracking-tight">Configuration</h2>
        <p className="text-[13px] text-[color:var(--text-secondary)] max-w-[720px]">
          Carve's settings: API keys, Logo AI, sign-in, addresses, the model service and
          backups. A value saved here takes precedence over <code>.env</code>; each section says
          when a change applies (API and worker settings within{" "}
          {q.data ? `${q.data.applies_within_seconds} seconds` : "seconds"}, with no restart).
          Keys are stored encrypted and shown only by their last four characters. Only the
          superadmin sees this page; every change is written to the audit log.
        </p>
      </Card>

      {q.isLoading && <p className="text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>}
      {q.isError && (
        <p className="text-[13px] text-[color:var(--danger)]">
          {errorText(q.error, "Could not load the settings.")}
        </p>
      )}

      {q.data && (
        <Tabs value={current} onValueChange={onTab} className="gap-4">
          <Tabs.List aria-label="Configuration sections" className="flex-wrap">
            {tabs.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id}>
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {tabs.map((t) => (
            <Tabs.Content key={t.id} value={t.id} className="grid gap-4">
              {"intro" in t && t.intro && (
                <p className="text-[12.5px] text-[color:var(--text-secondary)] max-w-[720px]">
                  {t.intro}
                </p>
              )}
              {t.id === "locked" ? (
                <StartupCard listing={q.data} />
              ) : (
                groups
                  .filter(([name]) => t.groups.includes(name))
                  .map(([name, items]) => (
                    <GroupCard key={name} name={name} items={items} listing={q.data} />
                  ))
              )}
            </Tabs.Content>
          ))}
        </Tabs>
      )}
    </SettingsLayout>
  );
}

function GroupCard({
  name,
  items,
  listing,
}: {
  name: string;
  items: AppSetting[];
  listing: AppSettingsListing;
}) {
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-0">
      <h3 className="text-[14px] font-semibold tracking-tight">{name}</h3>
      <p className="text-[12px] text-[color:var(--text-tertiary)] mt-0.5 mb-4">
        {APPLIES[items[0].service] ?? APPLIES.api}
      </p>
      {items[0].service === "model" && <ModelServiceBar listing={listing} />}
      {items[0].service === "backup" && <BackupsPanel />}
      {items.map((s) => (
        <SettingRow key={s.key} s={s} />
      ))}
    </Card>
  );
}

function StartupCard({ listing }: { listing: AppSettingsListing }) {
  return (
    <Card variant="surface" radius="lg" className="p-6 grid gap-3">
      <div>
        <h3 className="text-[14px] font-semibold tracking-tight">Server start-up (.env only)</h3>
        <p className="text-[12.5px] text-[color:var(--text-secondary)] mt-1 max-w-[680px]">
          These must match the database, storage and HTTPS certificate as they are: a new
          database password here would not change the database's own, it would only cut
          Carve off from its data, and a new pepper would break every password. So they are
          changed together with those services, in <code>.env</code>, then the containers are
          recreated.
        </p>
      </div>
      <ul className="grid gap-1.5">
        {listing.startup.map((v) => (
          <li key={v.key} className="flex items-center gap-3 text-[12.5px]">
            <span className="font-mono text-[11.5px] w-[200px] shrink-0">{v.key}</span>
            <span className="text-[color:var(--text-secondary)] flex-1">{v.label}</span>
            <Badge variant={v.set ? "neutral" : "ghost"}>{v.set ? "Set" : "Default"}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Armin Mehri — mehri.armin@gmail.com
/**
 * Collect from web — the body of the task page's dialog.
 *
 * Three tabs: **Keywords** (what to search for and how many images each
 * should bring), **Settings** (sources, size, filters) and **Past runs**.
 * The keyword list belongs to this task only and saves itself; the
 * settings are remembered in this browser. Collect starts a run for
 * every keyword short of its number. While a run works, its progress
 * sits above the tabs; closing the dialog does not stop it (it is a
 * server-side job with its own worker), Stop does, and the images
 * already added stay.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, ClipboardList, Globe, Keyboard, Plus, Square, Trash2 } from "lucide-react";

import {
  ACTIVE_STATUSES,
  parseKeywordList,
  REJECT_LABELS,
  splitTotal,
  webCollectApi,
  type WebCollectJob,
  type WebCollectKeywordIn,
  type WebCollectOptions,
  type WebCollectSource,
  type WebCollectState,
} from "@/api/webCollect";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { Textarea } from "@/components/ui/Textarea";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";

const DEFAULT_TARGET = 300;
const MIN_SIDES = [400, 500, 640, 800, 1024];
const OPTIONS_KEY = "carve.webCollect.options";
const SAVE_DELAY_MS = 700;
/** Sources added on 2026-11-08: ticked once for a saved choice that predates them. */
const ADDED_SOURCES: WebCollectSource[] = ["duckduckgo", "baidu", "so360"];

/** Plain-English help for each source, shown in its tooltip. */
const SOURCE_HELP: Record<WebCollectSource, string> = {
  bing:
    "Microsoft's image search. Finds the most images for common keywords. For rarer ones (a less-known brand) it often shows unrelated images; then it is skipped for that keyword.",
  duckduckgo:
    "DuckDuckGo's image search. Finds many images for almost any keyword, including brands Bing gets wrong. It searches slowly on purpose: when asked too fast it stops answering for a while, and is then skipped for the rest of the run.",
  baidu:
    "China's largest image search. Finds the real logos of many brands Bing gets wrong. Most images are on Chinese sites, so it finds little when “Skip images on Chinese sites” is ticked.",
  so360:
    "Chinese image search (360 Search). Like Baidu: good for brands and logos, mostly from Chinese sites, so it finds little when “Skip images on Chinese sites” is ticked.",
  yandex:
    "Russian image search. Has many images Bing does not have, but it often stops after a page or two and asks for a CAPTCHA. Then it is skipped for the rest of the run.",
  commons:
    "Wikipedia's library of free-to-use photos. No watermarks. Needs a contact address in Settings → Configuration.",
  openverse:
    "A search over millions of free-to-use images (Flickr, Wikimedia and more). No watermarks.",
  unsplash:
    "Free photo site. Beautiful photos of general things (people, cities, sport), but rarely a specific brand or logo. Needs a free key in Settings → Configuration.",
  pexels:
    "Free photo site. Good photos of general things, rarely a specific brand or logo. Needs a free key in Settings → Configuration.",
  pixabay:
    "Free photos and illustrations. Good for general things, rarely a specific brand or logo. Needs a free key in Settings → Configuration.",
};

interface Row extends WebCollectKeywordIn {
  /** Client-side key, stable across saves. */
  key: string;
  have: number;
  exhausted: boolean;
}

type Tab = "keywords" | "settings" | "history";

function loadOptions(): WebCollectOptions {
  const base: WebCollectOptions = {
    sources: ["bing", "duckduckgo", "baidu", "so360", "commons", "openverse"],
    min_side: 500,
    filter_ai: true,
    filter_watermark: true,
    filter_relevance: true,
    skip_chinese_sites: false,
    mode: "per_keyword",
  };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (!saved) return base;
    // Sources added after the choice was saved start ticked once.
    const { sources_added: seen, ...rest } = saved;
    const sources = [...new Set([...(rest.sources ?? base.sources), ...(seen ? [] : ADDED_SOURCES)])];
    return { ...base, ...rest, sources, restart_search: false };
  } catch {
    return base;
  }
}

function saveOptions(o: WebCollectOptions): void {
  try {
    const { restart_search: _skip, ...rest } = o;
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...rest, sources_added: true }));
  } catch {
    /* private window: settings just are not remembered */
  }
}

function apiMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string; error?: string } } })?.response
    ?.data;
  return data?.message ?? data?.error ?? "Something went wrong.";
}

function rowsFrom(state: WebCollectState): Row[] {
  return state.keywords.map((k) => ({
    key: k.id,
    id: k.id,
    keyword: k.keyword,
    target: k.target,
    have: k.have,
    exhausted: k.exhausted,
  }));
}

const fmt = (n: number) => n.toLocaleString();

/** A small "?" that explains the thing next to it. */
function Help({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Tooltip
      content={children}
      className="max-w-[300px] whitespace-normal font-normal leading-snug text-[12px] px-2.5 py-1.5"
    >
      <button
        type="button"
        aria-label={`About ${label}`}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/** A checkbox with its explanation in a tooltip. */
function Option({
  label,
  help,
  checked,
  onChange,
  disabled,
  note,
}: {
  label: string;
  help: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <Checkbox
        label={label}
        description={note}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="pt-0.5">
        <Help label={label}>{help}</Help>
      </span>
    </div>
  );
}

export function WebCollectDialog({ taskId, open }: { taskId: string; open: boolean }) {
  const qc = useQueryClient();
  const stateQ = useQuery({
    queryKey: ["web-collect", taskId],
    queryFn: () => webCollectApi.state(taskId),
    enabled: open,
    refetchInterval: (q) => ((q.state.data as WebCollectState | undefined)?.active ? 2_000 : false),
    refetchIntervalInBackground: true,
  });
  const state = stateQ.data;
  const active = state?.active ?? null;
  const running = !!active && ACTIVE_STATUSES.includes(active.status);

  const [tab, setTab] = useState<Tab>("keywords");
  const [rows, setRows] = useState<Row[]>([]);
  const [options, setOptions] = useState<WebCollectOptions>(loadOptions);
  // Unsaved keyword edits: bumped on every change; a save that answers
  // for an older version does not overwrite newer edits.
  const version = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  const delayRef = useRef(0);
  const [pendingVersion, setPendingVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const dirty = pendingVersion !== savedVersion;

  // Take the server's list whenever nothing is waiting to be saved.
  useEffect(() => {
    if (state && !dirty) {
      const fresh = rowsFrom(state);
      setRows(fresh);
      rowsRef.current = fresh;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, dirty]);

  // A finished run changes the task's images.
  const activeId = active?.id;
  useEffect(() => {
    if (!activeId) {
      qc.invalidateQueries({ queryKey: ["task-assets", taskId] });
      qc.invalidateQueries({ queryKey: ["task-assets-count", taskId] });
    }
  }, [activeId, qc, taskId]);

  const payload = (list: Row[]): WebCollectKeywordIn[] =>
    list
      .filter((r) => r.keyword.trim())
      .map((r) => ({ id: r.id, keyword: r.keyword.trim(), target: Math.max(0, r.target || 0) }));

  const save = useMutation({
    mutationFn: ({ list }: { list: Row[]; v: number }) =>
      webCollectApi.saveKeywords(taskId, payload(list)),
    onSuccess: (s, { v }) => {
      qc.setQueryData(["web-collect", taskId], s);
      setSavedVersion(v);
      if (v === version.current) {
        const fresh = rowsFrom(s);
        setRows(fresh);
        rowsRef.current = fresh;
      }
    },
    onError: (e, { v }) => {
      setSavedVersion(v);
      showToast(apiMessage(e), { variant: "error" });
      qc.invalidateQueries({ queryKey: ["web-collect", taskId] });
    },
  });

  /** Change the list; it saves itself (at once, or after a short pause
   *  while a number is being typed). Saves go one at a time, newest
   *  list each time, so an older list can never land after a newer one. */
  const edit = (next: Row[], soon = false) => {
    setRows(next);
    rowsRef.current = next;
    delayRef.current = soon ? SAVE_DELAY_MS : 0;
    version.current += 1;
    setPendingVersion(version.current);
  };
  useEffect(() => {
    if (!dirty || save.isPending) return;
    const t = setTimeout(
      () => save.mutate({ list: rowsRef.current, v: version.current }),
      delayRef.current,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVersion, savedVersion, save.isPending]);

  const toAdd = useMemo(
    () => rows.reduce((sum, r) => sum + Math.max(0, (r.target || 0) - r.have), 0),
    [rows],
  );

  const start = useMutation({
    mutationFn: async () => {
      if (dirty) {
        const v = version.current;
        const saved = await webCollectApi.saveKeywords(taskId, payload(rowsRef.current));
        qc.setQueryData(["web-collect", taskId], saved);
        setSavedVersion(v);
        const fresh = rowsFrom(saved);
        setRows(fresh);
        rowsRef.current = fresh;
      }
      saveOptions(options);
      return webCollectApi.start(taskId, options);
    },
    onSuccess: () => {
      setOptions((o) => ({ ...o, restart_search: false }));
      qc.invalidateQueries({ queryKey: ["web-collect", taskId] });
      showToast("Collecting. You can close this window; it keeps going.", { variant: "success" });
    },
    onError: (e) => showToast(apiMessage(e), { variant: "error" }),
  });

  const stop = useMutation({
    mutationFn: (jobId: string) => webCollectApi.cancel(taskId, jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["web-collect", taskId] }),
    onError: (e) => showToast(apiMessage(e), { variant: "error" }),
  });

  if (stateQ.isLoading || !state) {
    return <p className="text-[13px] text-[color:var(--text-secondary)] py-6">Loading…</p>;
  }

  const labels = Object.fromEntries(state.sources.map((s) => [s.name, s.label]));
  const usableSources = options.sources.filter((n) =>
    state.sources.some((s) => s.name === n && !s.needs),
  );
  const pastRuns = state.recent.filter((j) => j.id !== active?.id);

  return (
    <div className="flex flex-col gap-4" data-testid="web-collect">
      {running && active && (
        <RunProgress
          job={active}
          onStop={() => stop.mutate(active.id)}
          stopping={stop.isPending}
          labels={labels}
        />
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} variant="segment">
        <Tabs.List aria-label="Collect from web">
          <Tabs.Trigger value="keywords" data-testid="web-collect-tab-keywords">
            Keywords{rows.length ? ` (${rows.length})` : ""}
          </Tabs.Trigger>
          <Tabs.Trigger value="settings" data-testid="web-collect-tab-settings">
            Settings
          </Tabs.Trigger>
          <Tabs.Trigger value="history" data-testid="web-collect-tab-history">
            Past runs{pastRuns.length ? ` (${pastRuns.length})` : ""}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="keywords" className="pt-4">
          <KeywordsTab rows={rows} edit={edit} saving={save.isPending || dirty} />
        </Tabs.Content>

        <Tabs.Content value="settings" className="pt-4">
          <SettingsTab state={state} options={options} setOptions={setOptions} />
        </Tabs.Content>

        <Tabs.Content value="history" className="pt-4">
          {pastRuns.length ? (
            <RecentRuns jobs={pastRuns} />
          ) : (
            <p className="text-[13px] text-[color:var(--text-secondary)] py-3">No runs yet.</p>
          )}
        </Tabs.Content>
      </Tabs>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
        <span className="text-[12px] text-[color:var(--text-secondary)]">
          {running
            ? "A run is in progress. Changes apply to the next run."
            : usableSources.length === 0
              ? "Pick at least one source in Settings."
              : toAdd > 0
                ? `${fmt(toAdd)} images to collect for ${fmt(rows.filter((r) => r.target > r.have).length)} keywords`
                : rows.length
                  ? "Every keyword has its images. Raise a number to collect more."
                  : "Add keywords to start."}
        </span>
        <Tooltip
          content="Starts collecting in the background. You can close this window; it keeps going."
          className="max-w-[260px] whitespace-normal font-normal leading-snug text-[12px] px-2.5 py-1.5"
        >
          <span>
            <Button
              variant="primary"
              onClick={() => start.mutate()}
              disabled={running || start.isPending || toAdd <= 0 || usableSources.length === 0}
              loading={start.isPending}
              leftIcon={!start.isPending && <Globe className="h-4 w-4" />}
              data-testid="web-collect-start"
            >
              {start.isPending
                ? "Starting…"
                : toAdd > 0
                  ? `Collect ${fmt(toAdd)} images`
                  : "Collect images"}
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- keywords tab

/** Digits only, while typing: "" while the field is being cleared. */
const digits = (v: string) => v.replace(/[^0-9]/g, "").slice(0, 6);

/**
 * A whole-number field. A plain text box (not the browser's number box):
 * no "enter a valid value" checks, no odd step sizes, and clearing it to
 * type a new number does not jump back to a minimum. The number is taken
 * when you press Enter or leave the field; ↑ / ↓ change it by 1 (with
 * Shift by 10).
 */
function NumberField({
  value,
  onCommit,
  min = 0,
  label,
  testId,
  className,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  label: string;
  testId?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  const commit = (text = draft) => {
    const n = Number(text);
    if (text !== "" && Number.isFinite(n) && n >= min) {
      if (n !== value) onCommit(n);
    } else {
      setDraft(String(value));
    }
  };
  return (
    <Input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      data-testid={testId}
      className={className}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => setDraft(digits(e.target.value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = Number(draft) || 0;
          const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
          const next = Math.max(min, base + step);
          setDraft(String(next));
          onCommit(next);
        }
      }}
    />
  );
}

function KeywordsTab({
  rows,
  edit,
  saving,
}: {
  rows: Row[];
  edit: (next: Row[], soon?: boolean) => void;
  saving: boolean;
}) {
  const [mode, setMode] = useState<"one" | "list">("one");
  const [word, setWord] = useState("");
  // Kept as text while typing; read when a keyword is added.
  const [countText, setCountText] = useState(String(DEFAULT_TARGET));
  const [paste, setPaste] = useState("");
  const [total, setTotal] = useState("");

  const count = Math.max(1, Number(countText) || DEFAULT_TARGET);
  const known = new Set(rows.map((r) => r.keyword.trim().toLowerCase()));
  const pasted = parseKeywordList(paste, count);
  const pastedNew = pasted.filter((i) => !known.has(i.keyword.toLowerCase()));
  const wanted = rows.reduce((sum, r) => sum + (r.target || 0), 0);

  const addOne = () => {
    const keyword = word.replace(/\s+/g, " ").trim();
    if (!keyword) return;
    if (known.has(keyword.toLowerCase())) {
      showToast(`"${keyword}" is already in the list.`, { variant: "warning" });
      return;
    }
    edit([...rows, { key: crypto.randomUUID(), keyword, target: count, have: 0, exhausted: false }]);
    setWord("");
    setCountText(String(count));
  };

  const addList = () => {
    const seen = new Set(known);
    const added = pastedNew
      .filter((i) => !seen.has(i.keyword.toLowerCase()) && seen.add(i.keyword.toLowerCase()))
      .map((i) => ({ ...i, key: crypto.randomUUID(), have: 0, exhausted: false }));
    if (added.length) edit([...rows, ...added]);
    setPaste("");
    setMode("one");
  };

  const applyTotal = () => {
    const n = Number(total);
    if (!Number.isFinite(n) || n <= 0 || rows.length === 0) return;
    const parts = splitTotal(Math.round(n), rows.length);
    edit(rows.map((r, i) => ({ ...r, target: parts[i] })));
    setTotal("");
  };

  const countField = (
    <Input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label="Images"
      value={countText}
      onChange={(e) => setCountText(digits(e.target.value))}
      onBlur={() => setCountText(String(count))}
      data-testid="web-collect-new-count"
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
        <div className="flex items-center gap-1.5">
          <ModeButton active={mode === "one"} onClick={() => setMode("one")} icon={<Keyboard className="h-3.5 w-3.5" />}>
            Type a keyword
          </ModeButton>
          <ModeButton active={mode === "list"} onClick={() => setMode("list")} icon={<ClipboardList className="h-3.5 w-3.5" />}>
            Paste a list
          </ModeButton>
        </div>

        <div className="grid grid-cols-[1fr_120px] gap-2">
          <span className="flex items-center gap-1 text-[11px] text-[color:var(--text-tertiary)]">
            {mode === "one" ? "Keyword (what to search for)" : "Keywords, one per line"}
            <Help label="keywords">
              Each keyword is one search. Be specific: "Tenneco logo on a race car" finds better
              images than "Tenneco". Images are named after the keyword, e.g.
              tenneco_logo_000001.jpg.
            </Help>
          </span>
          <span className="flex items-center gap-1 text-[11px] text-[color:var(--text-tertiary)]">
            {mode === "one" ? "Images" : "Images each"}
            <Help label="number of images">
              How many images the keyword should have in this task. If the web does not have
              that many usable images, you get as many as could be found.
            </Help>
          </span>
        </div>

        {mode === "one" ? (
          <form
            noValidate
            className="grid grid-cols-[1fr_120px_auto] gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addOne();
            }}
          >
            <Input
              autoFocus
              value={word}
              placeholder="e.g. Tenneco logo"
              onChange={(e) => setWord(e.target.value)}
              data-testid="web-collect-new-keyword"
            />
            {countField}
            <Button type="submit" variant="secondary" disabled={!word.trim()} leftIcon={<Plus className="h-4 w-4" />}>
              Add
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_120px] gap-2 items-start">
              <Textarea
                autoFocus
                rows={6}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={"Tenneco logo\nCadillac F1 car, 500\nPirelli tyre | 200"}
                data-testid="web-collect-paste"
              />
              {countField}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[color:var(--text-tertiary)]">
                To give a line its own number, add it after a comma: <code>Pirelli tyre, 200</code>.
                Lines already in the list are skipped.
              </span>
              <Button
                variant="secondary"
                onClick={addList}
                disabled={pastedNew.length === 0}
                leftIcon={<Plus className="h-4 w-4" />}
              >
                Add {pastedNew.length || ""} keywords
              </Button>
            </div>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-[13px] text-[color:var(--text-secondary)] py-2">
          No keywords yet. Add one above, or paste a list.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_96px_150px_28px] gap-2 px-1 text-[11px] text-[color:var(--text-tertiary)]">
            <span>Keyword</span>
            <span className="flex items-center gap-1">
              Wanted
              <Help label="wanted">
                How many images this keyword should have. Click the number to change it, then
                press Enter (↑ and ↓ change it by 1). Raise it later to collect more.
              </Help>
            </span>
            <span className="flex items-center gap-1">
              In the task
              <Help label="in the task">
                Images collected for this keyword that are still in the task. If you delete some,
                the next run replaces them.
              </Help>
            </span>
            <span />
          </div>
          <div className="flex flex-col gap-1.5 max-h-[34vh] overflow-auto pr-1">
            {rows.map((r) => {
              const pct = r.target > 0 ? Math.min(100, (r.have / r.target) * 100) : 0;
              return (
                <div
                  key={r.key}
                  className="grid grid-cols-[1fr_96px_150px_28px] items-center gap-2"
                  data-testid="web-collect-row"
                >
                  <span className="truncate text-[13px] px-1" title={r.keyword}>
                    {r.keyword}
                  </span>
                  <NumberField
                    value={r.target}
                    label={`Images wanted for ${r.keyword}`}
                    onCommit={(n) =>
                      edit(
                        rows.map((x) => (x.key === r.key ? { ...x, target: n } : x)),
                        true,
                      )
                    }
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] tabular-nums">
                      {fmt(r.have)} / {fmt(r.target)}
                      {r.exhausted && r.have < r.target && (
                        <span className="text-[color:var(--warning)]"> · no more found</span>
                      )}
                    </span>
                    <div className="h-1 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                      <div className="h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <Tooltip content="Remove from the list. Images already collected stay in the task.">
                    <button
                      type="button"
                      aria-label={`Remove ${r.keyword}`}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] hover:text-[color:var(--danger)] hover:bg-[var(--bg-hover)]"
                      onClick={() => edit(rows.filter((x) => x.key !== r.key))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between px-1 text-[12px]">
            <span className="text-[color:var(--text-secondary)]">
              Total wanted: <span className="tabular-nums font-medium text-[color:var(--text-primary)]">{fmt(wanted)}</span>
            </span>
            <span className="flex items-center gap-1 text-[11px] text-[color:var(--text-tertiary)]">
              {saving ? "Saving…" : "Saved"} · for this task only
              <Help label="saving">
                The keyword list belongs to this task. It saves itself as you change it, and it is
                here next time you open this window. Other tasks have their own lists.
              </Help>
            </span>
          </div>

          {rows.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[color:var(--text-secondary)]">
              <span>Replace all numbers with an equal share of</span>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Total to share"
                className="w-24 h-8"
                value={total}
                placeholder="e.g. 5000"
                onChange={(e) => setTotal(digits(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyTotal();
                }}
              />
              <Button size="sm" variant="secondary" onClick={applyTotal} disabled={!total}>
                Apply
              </Button>
              <Help label="equal share">
                This replaces the number of every keyword. Example: 5,000 for 10 keywords sets each
                one to 500. You can still change single numbers afterwards. Leave it empty to keep
                your own numbers.
              </Help>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] border transition-colors",
        active
          ? "bg-[var(--accent-bg)] text-[color:var(--accent)] border-[var(--accent-bg-hover)]"
          : "bg-transparent text-[color:var(--text-secondary)] border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ------------------------------------------------------------- settings tab

function SettingsTab({
  state,
  options,
  setOptions,
}: {
  state: WebCollectState;
  options: WebCollectOptions;
  setOptions: (fn: (o: WebCollectOptions) => WebCollectOptions) => void;
}) {
  const toggleSource = (s: WebCollectSource, on: boolean) =>
    setOptions((o) => ({
      ...o,
      sources: on ? [...new Set([...o.sources, s])] : o.sources.filter((x) => x !== s),
    }));
  const blocked = (state.blocked_counts.stock ?? 0) + (state.blocked_counts.ai ?? 0);

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Where to search"
        help="The sites the images come from. If one of them stops answering (a limit, a CAPTCHA or a block), the run skips it and carries on with the others."
      >
        {(
          [
            ["web", "Search engines"],
            ["open", "Free-to-use archives"],
            ["photos", "Free photo sites"],
          ] as const
        ).map(([kind, title]) => (
          <div key={kind} className="flex flex-wrap items-start gap-x-5 gap-y-2">
            <span className="w-full sm:w-36 text-[11px] text-[color:var(--text-tertiary)] pt-0.5">
              {title}
            </span>
            {state.sources
              .filter((s) => s.kind === kind)
              .map((s) => (
                <Option
                  key={s.name}
                  label={s.label}
                  help={SOURCE_HELP[s.name]}
                  note={s.needs ? `Needs ${s.needs}` : undefined}
                  disabled={!!s.needs}
                  checked={!s.needs && options.sources.includes(s.name)}
                  onChange={(on) => toggleSource(s.name, on)}
                />
              ))}
          </div>
        ))}
      </Section>

      <Section
        title="Which images to keep"
        help="Every image is checked before it is added. An image that is turned away is not kept, and the run looks for another one instead."
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px]">Smallest size</span>
          <Select
            value={String(options.min_side)}
            onValueChange={(v) => setOptions((o) => ({ ...o, min_side: Number(v) }))}
          >
            <Select.Trigger aria-label="Smallest size" className="w-28 h-8">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {MIN_SIDES.map((m) => (
                <Select.Item key={m} value={String(m)}>
                  {m} px
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <Help label="smallest size">
            Images smaller than this on their short side are skipped. Example: with 500 px, an
            image of 800 × 450 is skipped. 500 px is a good minimum for training.
          </Help>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Option
            label="Skip AI-made images"
            help="Skips images that look made by a computer: AI art and 3D renders. It sometimes also skips flat logos or product pictures; if a logo keyword gets too few images, untick this."
            checked={options.filter_ai}
            onChange={(on) => setOptions((o) => ({ ...o, filter_ai: on }))}
          />
          <Option
            label="Skip watermarked images"
            help="Skips images with a stock-photo watermark across them (Alamy, Getty, Shutterstock and similar)."
            checked={options.filter_watermark}
            onChange={(on) => setOptions((o) => ({ ...o, filter_watermark: on }))}
          />
          <Option
            label="Skip images that don't match the keyword"
            help="Looks at each image and skips it if it doesn't show what its keyword says. Example: for “Shell logo”, a photo of a seashell is skipped. It misses some wrong images, mostly other companies' logos with the same word."
            checked={options.filter_relevance}
            onChange={(on) => setOptions((o) => ({ ...o, filter_relevance: on }))}
          />
          <Option
            label="Skip images on Chinese sites"
            help="Leaves out images whose site is Chinese (.cn addresses, Baidu, Sohu, Weibo and similar). Many are reposts with a watermark, but the other checks above already skip those. Baidu and 360 Search find mostly Chinese sites, so with this ticked they add little."
            checked={options.skip_chinese_sites}
            onChange={(on) => setOptions((o) => ({ ...o, skip_chinese_sites: on }))}
          />
        </div>
        <p className="flex items-center gap-1 text-[11px] text-[color:var(--text-tertiary)]">
          Always skipped: copies of images already in the task, animated images, and{" "}
          {fmt(blocked)} stock and AI-art sites.
          <Help label="always skipped">
            Exact copies and resized copies are skipped, also of images you uploaded yourself.
            The list of blocked sites can be extended in Settings → Configuration → Collect from
            web.
          </Help>
        </p>
      </Section>

      <Section title="How to search" help="These change how keywords share the work and where a search starts.">
        <Option
          label="Fill gaps from other keywords"
          help="If a keyword cannot find enough images, the other keywords collect the missing ones instead, so the total stays the same. Example: 10 keywords × 100; one finds only 60, so the others collect 40 more between them."
          checked={options.mode === "total"}
          onChange={(on) => setOptions((o) => ({ ...o, mode: on ? "total" : "per_keyword" }))}
        />
        <Option
          label="Start the search from the beginning"
          help="Normally a run continues where the last run of the same keyword stopped, so it only looks at results it has not seen yet. Tick this to go through the search results from the top again, for example weeks later when new images may be there. Images you already have are never added twice."
          checked={!!options.restart_search}
          onChange={(on) => setOptions((o) => ({ ...o, restart_search: on }))}
        />
      </Section>

      <p className="text-[11px] text-[color:var(--text-tertiary)]">
        These settings are remembered on this computer.
      </p>
    </div>
  );
}

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
        {title}
        <Help label={title}>{help}</Help>
      </h3>
      <div className="flex flex-col gap-3 pl-0.5">{children}</div>
    </section>
  );
}

// --------------------------------------------------------------- progress

function RunProgress({
  job,
  onStop,
  stopping,
  labels,
}: {
  job: WebCollectJob;
  onStop: () => void;
  stopping: boolean;
  labels: Record<string, string>;
}) {
  const pct = job.target > 0 ? Math.min(100, (job.added / job.target) * 100) : 0;
  const reasons = Object.entries(job.rejected_by ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <section
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--accent-bg-hover)] bg-[var(--accent-bg)] p-3"
      data-testid="web-collect-progress"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
          </span>
          <span className="text-[13px] font-semibold">
            {job.status === "canceling"
              ? "Stopping…"
              : job.status === "queued"
                ? "Starting…"
                : `Collecting: ${fmt(job.added)} of ${fmt(job.target)} images`}
          </span>
          <Help label="the run">
            This runs on the server: you can close this window or the page and it keeps going.
            If a site stops answering, the others carry on. When no site can find more, the run
            ends with what it has.
          </Help>
        </div>
        <Tooltip content="Stops now. Images already added stay in the task.">
          <span>
            <Button
              size="sm"
              variant="danger"
              onClick={onStop}
              disabled={stopping || job.status === "canceling"}
              leftIcon={<Square className="h-3 w-3" />}
              data-testid="web-collect-stop"
            >
              Stop
            </Button>
          </span>
        </Tooltip>
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-elev)] overflow-hidden">
        <div className="h-full bg-[var(--accent)] transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[color:var(--text-secondary)] tabular-nums">
        <span>{fmt(job.searches)} searches</span>
        <span>{fmt(job.found)} found</span>
        <span>{fmt(job.downloaded)} downloaded</span>
        <span>{fmt(job.rejected)} turned away</span>
        {job.failed > 0 && <span>{fmt(job.failed)} could not be downloaded</span>}
      </div>
      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {reasons.map(([k, v]) => (
            <Badge key={k} variant="neutral">
              {REJECT_LABELS[k] ?? k.replace(/_/g, " ")}: {fmt(v)}
            </Badge>
          ))}
        </div>
      )}
      <SourceStatus job={job} labels={labels} />
      {job.notice && <p className="text-[12px] text-[color:var(--warning)]">{job.notice}</p>}
      <div className="flex flex-col gap-1.5 max-h-[22vh] overflow-auto pr-1">
        {job.keywords.map((k) => {
          const kp = k.want > 0 ? Math.min(100, (k.added / k.want) * 100) : 100;
          return (
            <div key={k.keyword_id} className="grid grid-cols-[1fr_140px_96px] items-center gap-2 text-[12px]">
              <span className="truncate" title={k.keyword}>
                {k.keyword}
              </span>
              <div className="h-1.5 rounded-full bg-[var(--bg-elev)] overflow-hidden">
                <div
                  className={cn(
                    "h-full",
                    k.status === "exhausted" || k.status === "limited"
                      ? "bg-[var(--warning)]"
                      : "bg-[var(--accent)]",
                  )}
                  style={{ width: `${kp}%` }}
                />
              </div>
              <span
                className="tabular-nums text-right"
                title={
                  k.status === "exhausted"
                    ? "No more images found anywhere"
                    : k.status === "limited"
                      ? "The sites that had more stopped answering"
                      : undefined
                }
              >
                {fmt(k.added)}/{fmt(k.want)}
                {k.status === "exhausted"
                  ? " · none left"
                  : k.status === "limited"
                    ? " · sites stopped"
                    : k.status === "done"
                      ? " ✓"
                      : ""}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SourceStatus({ job, labels }: { job: WebCollectJob; labels: Record<string, string> }) {
  const entries = Object.entries(job.source_stats ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="web-collect-sources">
      {entries.map(([name, st]) => (
        <Tooltip
          key={name}
          content={
            st.status === "stopped"
              ? `Stopped for this run: ${st.note ?? "a limit or a block"}`
              : `${fmt(st.searches)} searches, ${fmt(st.found)} images found` +
                (st.off_topic
                  ? `. Skipped for ${fmt(st.off_topic)} keyword${st.off_topic === 1 ? "" : "s"}: its images were about something else.`
                  : "")
          }
          className="max-w-[300px] whitespace-normal font-normal leading-snug text-[12px] px-2.5 py-1.5"
        >
          <span>
            <Badge variant={st.status === "stopped" ? "warning" : st.status === "error" ? "danger" : "success"}>
              {labels[name] ?? name}: {fmt(st.added)} added
              {st.status === "stopped" ? " · stopped" : ""}
            </Badge>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function RecentRuns({ jobs }: { jobs: WebCollectJob[] }) {
  return (
    <div className="flex flex-col gap-2">
      {jobs.map((j) => (
        <div
          key={j.id}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-[12px] border-b border-[var(--border-subtle)] pb-2"
        >
          <span className="text-[color:var(--text-secondary)]">
            {new Date(j.created_at).toLocaleString()}
          </span>
          <span className="tabular-nums">
            {fmt(j.added)} of {fmt(j.target)} added · {fmt(j.rejected)} turned away
          </span>
          <Badge
            variant={j.status === "completed" ? "success" : j.status === "failed" ? "danger" : "neutral"}
          >
            {j.status === "completed" && j.added < j.target
              ? j.keywords?.some((k) => k.status === "limited")
                ? "sites stopped"
                : "ran out"
              : j.status}
          </Badge>
          {j.error && <span className="col-span-3 text-[11px] text-[color:var(--danger)]">{j.error}</span>}
        </div>
      ))}
    </div>
  );
}

/** A small "Collecting 340/1000" chip for the task page while a run works. */
export function WebCollectStatusChip({ taskId, enabled }: { taskId: string; enabled: boolean }) {
  const q = useQuery({
    queryKey: ["web-collect", taskId],
    queryFn: () => webCollectApi.state(taskId),
    enabled,
    refetchInterval: (query) => ((query.state.data as WebCollectState | undefined)?.active ? 5_000 : 60_000),
    refetchIntervalInBackground: true,
  });
  const job = q.data?.active;
  if (!job) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] bg-[var(--accent-bg)] text-[color:var(--accent)] tabular-nums"
      title="Collect from web is running"
      data-testid="web-collect-chip"
    >
      <Globe className="h-3.5 w-3.5" />
      {job.status === "canceling" ? "Stopping…" : `Collecting ${fmt(job.added)}/${fmt(job.target)}`}
    </span>
  );
}

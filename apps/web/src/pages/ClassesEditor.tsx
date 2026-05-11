// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2, Plus, ClipboardPaste } from "lucide-react";
import { classesApi, type ClassRow } from "@/api/classes";
import { projectsApi, type Project } from "@/api/projects";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { showToast } from "@/lib/toast";
import { PALETTE_HEX, nextUnusedColor } from "@/lib/swatch";

export function ClassesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });
  // Any class mutation can change the per-task class-count chip in
  // ProjectDetailPage (keyed by ``["task-classes", projectId, taskId]``)
  // — invalidate the prefix so every task row refetches its count
  // without the user having to refresh the page.
  function invalidateClassDependents() {
    qc.invalidateQueries({ queryKey: ["classes", projectId] });
    qc.invalidateQueries({ queryKey: ["task-classes", projectId] });
  }
  const create = useMutation({
    mutationFn: (input: { idx: number; name: string; color: string }) =>
      classesApi.create(projectId, input),
    onSuccess: () => invalidateClassDependents(),
    // v3.2 Issue 7 — surface the 409 duplicate-name error as a toast so the
    // user understands why the create silently no-op'd. `pendingName` is
    // captured from the mutation variables (TanStack Query passes them as
    // the second argument to onError).
    onError: (err: unknown, variables: { idx: number; name: string; color: string }) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response
        ?.data?.detail;
      const pendingName = variables.name;
      if (detail === "class_idx_or_name_conflict") {
        showToast(
          `A class named "${pendingName}" already exists in this project.`,
          { variant: "error" },
        );
      } else {
        showToast("Failed to add class.", { variant: "error" });
      }
    },
  });
  const remove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => invalidateClassDependents(),
  });
  // v3.30 — `updatePrompt` mutation removed alongside the per-class
  // prompt input. Prompt edits now flow through Auto-Annotate /
  // Smart Find dialogs, which save via classesApi.update directly.
  const importFrom = useMutation({
    mutationFn: (sourceProjectId: string) =>
      projectsApi.importClasses(projectId, sourceProjectId),
    onSuccess: (result) => {
      invalidateClassDependents();
      showToast(
        `Imported ${result.imported} ${result.imported === 1 ? "class" : "classes"} (${result.skipped} skipped)`,
        { variant: "success" },
      );
    },
    onError: () => {
      showToast("Failed to import classes", { variant: "error" });
    },
  });

  const [copyDialogOpen, setCopyDialogOpen] = useState(false);

  const classCount = q.data?.length ?? 0;
  const usedColors = (q.data ?? []).map((c) => c.color);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(() => nextUnusedColor(usedColors));
  const nextIdx = (q.data ?? []).reduce((m, c) => Math.max(m, c.idx + 1), 0);
  const [bulkPasteOpen, setBulkPasteOpen] = useState(false);

  // Track the next-up palette slot so successive adds get distinct colors
  // that don't collide with any color already taken in this project.
  // Runs only when the count changes (after fetch / create / delete).
  useEffect(() => {
    setColor(nextUnusedColor(usedColors));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classCount]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Guard against rapid double-submits that v2.6's relaxed rate limits
    // exposed: the button can fire twice before the previous mutation
    // resolves, which we want the React-Query state to short-circuit.
    if (create.isPending) return;
    // CRITICAL: catch the rejection here. `mutateAsync` re-throws on
    // failure (e.g. 429, 500, network), and a bare `await` inside an
    // `async` form handler turns that into an unhandled promise rejection
    // that React surfaces as a tree-level crash ("Add class breaks the
    // UI"). The mutation's `onError` is the right place for telemetry;
    // here we just need to keep the form alive so the user can retry.
    try {
      await create.mutateAsync({ idx: nextIdx, name, color });
      setName("");
      setColor(nextUnusedColor([...usedColors, color]));
    } catch {
      // React-Query keeps the rejected error on `create.error`; the form
      // stays open with the user's input intact so they can retry.
    }
  }

  return (
    <section className="grid gap-3 min-h-0">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
          Classes
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="classes-editor-bulk-paste"
            onClick={() => setBulkPasteOpen(true)}
            aria-label="Paste classes — bulk import from list, JSON, or YAML"
            title="Paste classes — bulk import from list, JSON, or YAML"
            className={cn(
              "grid h-7 w-7 place-items-center",
              "rounded-[var(--radius-6)] border border-[var(--border-subtle)]",
              "text-[color:var(--text-secondary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              "transition-colors duration-[180ms] ease-out",
            )}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid="classes-editor-copy-from-project"
            onClick={() => setCopyDialogOpen(true)}
            aria-label="Copy classes from another project"
            title="Copy classes from another project"
            className={cn(
              "grid h-7 w-7 place-items-center",
              "rounded-[var(--radius-6)] border border-[var(--border-subtle)]",
              "text-[color:var(--text-secondary)]",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              "transition-colors duration-[180ms] ease-out",
            )}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <span className="ml-1 font-mono text-[10.5px] text-[color:var(--text-tertiary)] whitespace-nowrap">
            {q.data?.length ?? 0} defined
          </span>
        </div>
      </header>
      <CopyClassesFromProjectDialog
        open={copyDialogOpen}
        onOpenChange={setCopyDialogOpen}
        currentProjectId={projectId}
        onConfirm={(sourceProjectId) => {
          importFrom.mutate(sourceProjectId, {
            onSettled: () => setCopyDialogOpen(false),
          });
        }}
        pending={importFrom.isPending}
      />
      <BulkPasteClassesDialog
        open={bulkPasteOpen}
        onOpenChange={setBulkPasteOpen}
        existingNames={(q.data ?? []).map((c) => c.name.toLowerCase())}
        existingColors={usedColors}
        startIdx={nextIdx}
        onSubmit={async (entries) => {
          // Sequentially create — server-side enforces idx+name uniqueness;
          // sequential keeps idx allocation deterministic.
          let created = 0;
          let skipped = 0;
          for (const e of entries) {
            try {
              await create.mutateAsync({ idx: e.idx, name: e.name, color: e.color });
              created++;
            } catch {
              skipped++;
            }
          }
          showToast(
            `Imported ${created} ${created === 1 ? "class" : "classes"}${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
            { variant: created > 0 ? "success" : "error" },
          );
          setBulkPasteOpen(false);
        }}
      />

      {/* Bounded shell: header (sticky) / scrollable list / footer (sticky add form).
          max-h caps page growth so adding many classes doesn't push siblings down. */}
      <div
        data-testid="classes-editor-shell"
        className={cn(
          "grid grid-rows-[auto_1fr_auto] max-h-[calc(100vh-280px)] min-h-[320px]",
          "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]",
          "overflow-hidden",
        )}
      >
        <header
          data-testid="classes-editor-header"
          className="px-3 py-2 border-b border-[var(--border-subtle)] text-[11px] uppercase tracking-[0.08em] text-[color:var(--text-tertiary)] font-medium"
        >
          {q.data && q.data.length > 0
            ? `${q.data.length} ${q.data.length === 1 ? "class" : "classes"}`
            : "Classes"}
        </header>

        <div
          data-testid="classes-editor-list"
          className="overflow-y-auto px-2 py-2"
        >
          {q.isLoading && (
            <p className="text-[color:var(--text-tertiary)] text-[13px] px-1 py-2">
              Loading…
            </p>
          )}
          {q.data && q.data.length === 0 && (
            <p className="text-[color:var(--text-tertiary)] text-[13px] italic px-1 py-2">
              No classes defined yet.
            </p>
          )}
          <ul className="grid gap-1">
            {q.data?.map((c: ClassRow) => (
              <li
                key={c.id}
                className={cn(
                  "grid gap-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3 py-1.5",
                  "transition-colors hover:border-[var(--border-strong)]",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    aria-label={`Class ${c.idx} color`}
                    className="h-3 w-3 shrink-0 rounded-full border border-[var(--border-strong)]"
                    style={{ background: c.color }}
                  />
                  <span className="font-mono text-[10px] text-[color:var(--text-tertiary)] w-6">
                    #{c.idx}
                  </span>
                  <span className="flex-1 text-[13px] tracking-tight text-[color:var(--text-primary)] truncate">
                    {c.name}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete class?",
                        description: (
                          <>
                            Remove the class{" "}
                            <span className="font-medium text-[color:var(--text-primary)]">
                              {c.name}
                            </span>
                            ? Every annotation that uses it across the
                            entire project will be{" "}
                            <span className="font-medium text-[color:var(--danger)]">
                              permanently deleted
                            </span>
                            . The remaining classes will be renumbered so
                            their order stays contiguous. This action is
                            irreversible.
                          </>
                        ),
                        variant: "danger",
                        confirmLabel: "Delete",
                      });
                      if (ok) remove.mutate(c.id);
                    }}
                    aria-label={`Delete class ${c.name}`}
                    className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] transition-colors hover:bg-[var(--danger-bg)] hover:text-[color:var(--danger)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {/* v3.30 — per-class SAM text prompt input removed.
                    Auto-Annotate and Smart Find now expose inline
                    class+prompt rows in their dialogs, so this
                    permanently-visible sub-row was redundant chrome. */}
              </li>
            ))}
          </ul>
        </div>

        <form
          data-testid="classes-editor-footer"
          onSubmit={onSubmit}
          className="grid gap-2 px-3 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-elev)]"
        >
          <Input
            label="Class name"
            required
            minLength={1}
            maxLength={120}
            placeholder="e.g. car, person, nucleus"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {/* v3.2 Issue 6 — preset swatch grid above the native picker so
              users can one-click a palette color or mix a custom hex. The
              currently-selected preset (if any) is highlighted. */}
          <div className="grid gap-1.5">
            <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
              Color
            </span>
            <div
              data-testid="classes-editor-swatch-grid"
              className="grid grid-cols-6 gap-1"
            >
              {PALETTE_HEX.map((c) => {
                const isSelected = c.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Set color ${c}`}
                    data-testid={`classes-editor-swatch-${c}`}
                    data-selected={isSelected ? "true" : undefined}
                    onClick={() => setColor(c)}
                    className={cn(
                      "h-6 w-6 rounded-[var(--radius-xs)] border border-[var(--border-subtle)]",
                      "transition-transform hover:scale-110",
                      isSelected && "ring-2 ring-[var(--accent)] ring-offset-1",
                    )}
                    style={{ background: c }}
                  />
                );
              })}
            </div>
          </div>
          <div className="flex items-end gap-2">
            <label className="grid gap-1.5">
              <span className="text-[12px] tracking-tight text-[color:var(--text-secondary)] font-medium">
                Custom
              </span>
              <input
                type="color"
                aria-label="Color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elev)]"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={create.isPending}
              leftIcon={!create.isPending && <Plus className="h-4 w-4" />}
              className="flex-1"
            >
              {create.isPending ? "Adding" : "Add class"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bulk copy classes from another project (v3.0 Bug 8). Keeps the picker tiny —
// authenticated users see all projects, so a flat list with the current
// project filtered out is enough.
// ---------------------------------------------------------------------------
interface CopyClassesFromProjectDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  currentProjectId: string;
  onConfirm: (sourceProjectId: string) => void;
  pending: boolean;
}

function CopyClassesFromProjectDialog({
  open,
  onOpenChange,
  currentProjectId,
  onConfirm,
  pending,
}: CopyClassesFromProjectDialogProps) {
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    enabled: open,
  });
  const [selected, setSelected] = useState<string | null>(null);

  // Reset selection whenever the dialog re-opens so a stale highlight doesn't
  // carry over to the next session.
  useEffect(() => {
    if (open) setSelected(null);
  }, [open]);

  const candidates: Project[] = (projectsQ.data ?? []).filter(
    (p) => p.id !== currentProjectId,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,460px)]">
        <DialogHeader>
          <DialogTitle>Copy classes from another project</DialogTitle>
          <DialogDescription>
            Pick a source project. Existing classes in this project are kept;
            only new names are copied with their colors and indices.
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="copy-classes-project-list"
          className="grid gap-1 max-h-[320px] overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-1"
        >
          {projectsQ.isLoading && (
            <p className="text-[13px] text-[color:var(--text-tertiary)] px-2 py-3">
              Loading projects…
            </p>
          )}
          {!projectsQ.isLoading && candidates.length === 0 && (
            <p className="text-[13px] text-[color:var(--text-tertiary)] italic px-2 py-3">
              No other projects available.
            </p>
          )}
          {candidates.map((p) => {
            const isSelected = selected === p.id;
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`copy-classes-source-${p.id}`}
                onClick={() => setSelected(p.id)}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-xs)]",
                  "text-left text-[13px] tracking-tight transition-colors",
                  isSelected
                    ? "bg-[var(--accent-subtle,var(--bg-hover))] text-[color:var(--text-primary)] outline outline-1 outline-[var(--accent)]"
                    : "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                )}
              >
                <span className="flex-1 truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            data-testid="copy-classes-confirm"
            disabled={!selected || pending}
            loading={pending}
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
          >
            {pending ? "Copying" : "Copy classes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// v3.30 — ClassPromptInput removed. Inline class+prompt editing
// now lives in the Auto-Annotate / Smart Find dialogs.

// ---------------------------------------------------------------------------
// Bulk paste classes — accepts plain list / JSON array / YAML list and auto-
// assigns unique colors. Names are deduped against the existing project's
// classes (case-insensitive). Idx allocation continues from the project's
// current max.
// ---------------------------------------------------------------------------
interface BulkPasteEntry {
  idx: number;
  name: string;
  color: string;
}

interface BulkPasteClassesDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existingNames: readonly string[];
  existingColors: readonly string[];
  startIdx: number;
  onSubmit: (entries: BulkPasteEntry[]) => void | Promise<void>;
}

function parsePastedClasses(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  // 1. JSON array of strings or `{name: ...}` objects.
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (entry && typeof entry === "object" && "name" in entry) {
              const n = (entry as { name?: unknown }).name;
              return typeof n === "string" ? n : "";
            }
            return "";
          })
          .filter((s) => s.trim().length > 0);
      }
    } catch {
      /* fall through to line / yaml parser */
    }
  }
  // 2. YAML-style list (- name) or newline / comma split.
  return trimmed
    .split(/\r?\n|,/)
    .map((line) => line.replace(/^[\s-]+/, "").replace(/^["']|["']$/g, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function BulkPasteClassesDialog({
  open,
  onOpenChange,
  existingNames,
  existingColors,
  startIdx,
  onSubmit,
}: BulkPasteClassesDialogProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setText("");
      setSubmitting(false);
    }
  }, [open]);

  const parsed = parsePastedClasses(text);
  const existingSet = new Set(existingNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const fresh: string[] = [];
  const duplicates: string[] = [];
  for (const raw of parsed) {
    const key = raw.toLowerCase();
    if (existingSet.has(key) || seen.has(key)) {
      duplicates.push(raw);
    } else {
      seen.add(key);
      fresh.push(raw);
    }
  }

  // Pre-compute color assignments for preview.
  const used: string[] = [...existingColors];
  const entries: BulkPasteEntry[] = fresh.map((name, i) => {
    const color = nextUnusedColor(used);
    used.push(color);
    return { idx: startIdx + i, name, color };
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,560px)]">
        <DialogHeader>
          <DialogTitle>Paste classes</DialogTitle>
          <DialogDescription>
            One class per line, comma-separated, JSON array, or YAML list.
            Colors are auto-assigned so no two classes share a color.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={8}
          placeholder={'car\nperson\nbike\n\n— or —\n\n["car", "person", "bike"]\n\n— or —\n\n- car\n- person\n- bike'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="bulk-paste-classes-input"
          className="font-mono leading-relaxed"
        />
        {entries.length > 0 && (
          <div className="grid gap-1 max-h-[260px] overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2">
            <span className="text-[10.5px] tracking-tight text-[color:var(--text-tertiary)] sticky top-0 bg-[var(--bg-sunken)] -mx-2 -mt-2 px-2 pt-2 pb-1">
              Preview ({entries.length} new
              {duplicates.length > 0 ? `, ${duplicates.length} duplicate skipped` : ""})
            </span>
            {entries.map((e) => (
              <div
                key={`${e.idx}-${e.name}`}
                className="flex items-center gap-2 text-[12px] tracking-tight text-[color:var(--text-secondary)]"
              >
                <span
                  className="h-3 w-3 rounded-full border border-[var(--border-strong)]"
                  style={{ background: e.color }}
                />
                <span className="font-mono text-[10px] text-[color:var(--text-tertiary)] w-6">
                  #{e.idx}
                </span>
                <span className="flex-1 truncate text-[color:var(--text-primary)]">
                  {e.name}
                </span>
                <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">
                  {e.color}
                </span>
              </div>
            ))}
          </div>
        )}
        {parsed.length === 0 && text.trim().length > 0 && (
          <p className="text-[12px] text-[color:var(--danger)]">
            Couldn't find any class names in that input.
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={entries.length === 0 || submitting}
            loading={submitting}
            onClick={async () => {
              setSubmitting(true);
              await onSubmit(entries);
            }}
            data-testid="bulk-paste-classes-submit"
          >
            {submitting
              ? "Importing…"
              : `Import ${entries.length} ${entries.length === 1 ? "class" : "classes"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

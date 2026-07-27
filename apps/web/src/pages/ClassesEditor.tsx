// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Trash2, Plus, ClipboardPaste, Pencil, Check, X } from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import { deleteClassWithConfirm } from "@/lib/deleteClassWithConfirm";
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
  // Deletion is handled by `deleteClassWithConfirm` (below) rather than a
  // bare mutation: it runs a guarded probe to learn the true annotation
  // count and escalates to a type-to-confirm dialog before the
  // irreversible cascade. See onDelete in the class row.
  // Inline rename / recolor. Same 409 conflict detail surfaces here as
  // for create, so we reuse the toast message keyed on the attempted
  // name. Caller wraps mutateAsync so it can roll back the local draft.
  const update = useMutation({
    mutationFn: ({
      cid,
      patch,
    }: {
      cid: string;
      // v3.31 — patch shape widened to include the hierarchy parent.
      // ``parent_class_id: null`` clears the parent (turns the class
      // back into a top-level class); omitting the key leaves it.
      patch: {
        name?: string;
        color?: string;
        parent_class_id?: string | null;
      };
    }) => classesApi.update(projectId, cid, patch),
    onSuccess: () => invalidateClassDependents(),
    onError: (err: unknown, variables) => {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      if (detail === "class_idx_or_name_conflict" && variables.patch.name) {
        showToast(
          `A class named "${variables.patch.name}" already exists in this project.`,
          { variant: "error" },
        );
      } else if (detail === "class_hierarchy_invalid") {
        // v3.31 — server rejected the parent assignment (cycle, depth
        // limit, cross-project, etc). Surface a friendly toast; the
        // dropdown will revert because the mutation throws.
        showToast(
          "Invalid parent class — that would create a cycle or exceed the hierarchy depth.",
          { variant: "error", duration: 5000 },
        );
      } else {
        showToast("Failed to update class.", { variant: "error" });
      }
    },
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
              <ClassEditorRow
                key={c.id}
                cls={c}
                allClasses={q.data ?? []}
                onRename={(next) =>
                  update.mutateAsync({ cid: c.id, patch: { name: next } })
                }
                onChangeColor={(next) =>
                  update.mutateAsync({ cid: c.id, patch: { color: next } })
                }
                onChangeParent={(next) =>
                  update.mutateAsync({
                    cid: c.id,
                    patch: { parent_class_id: next },
                  })
                }
                onDelete={async () => {
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
                  if (!ok) return;
                  try {
                    const res = await deleteClassWithConfirm({
                      projectId,
                      classId: c.id,
                      className: c.name,
                      confirm,
                    });
                    if (res.deleted) {
                      invalidateClassDependents();
                      if (res.annotationsDeleted > 0) {
                        showToast(
                          `Deleted "${c.name}" and ${res.annotationsDeleted.toLocaleString()} annotations`,
                          { variant: "success" },
                        );
                      }
                    }
                  } catch {
                    showToast("Failed to delete class.", { variant: "error" });
                  }
                }}
              />
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
// Per-row inline editor. Click the swatch → palette popover. Click the
// name (or the pencil) → input becomes editable; Enter commits, Esc
// cancels, blur commits. Both flows go through ``classesApi.update``;
// the row reverts its local draft if the server rejects (e.g. 409
// duplicate-name) so the displayed value never drifts from the server.
// ---------------------------------------------------------------------------

interface ClassEditorRowProps {
  cls: ClassRow;
  // v3.31 — full project class list, needed to render the hierarchy
  // parent dropdown (eligible options + indented display).
  allClasses: ReadonlyArray<ClassRow>;
  onRename: (next: string) => Promise<unknown>;
  onChangeColor: (next: string) => Promise<unknown>;
  // v3.31 — null clears the parent (turn back into top-level class).
  onChangeParent: (next: string | null) => Promise<unknown>;
  onDelete: () => void;
}

function ClassEditorRow({
  cls,
  allClasses,
  onRename,
  onChangeColor,
  onChangeParent,
  onDelete,
}: ClassEditorRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cls.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync with the server-provided name whenever it
  // changes externally (refetch, optimistic invalidation, another tab).
  useEffect(() => {
    if (!editing) setDraft(cls.name);
  }, [cls.name, editing]);

  function startEdit() {
    setDraft(cls.name);
    setEditing(true);
    // Defer to ensure the input is mounted before we try to focus it.
    queueMicrotask(() => inputRef.current?.select());
  }

  function cancelEdit() {
    setDraft(cls.name);
    setEditing(false);
  }

  async function commitEdit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === cls.name) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await onRename(trimmed);
      setEditing(false);
    } catch {
      // Mutation's onError surfaces the toast; revert the draft so the
      // user can see why the rename didn't stick.
      setDraft(cls.name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li
      className={cn(
        "grid gap-1 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3 py-1.5",
        "transition-colors hover:border-[var(--border-strong)]",
        "min-w-0 overflow-hidden",
        "group",
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <ClassColorPopover
          color={cls.color}
          ariaLabel={`Change color of class ${cls.name}`}
          onChange={(next) => {
            if (next.toLowerCase() === cls.color.toLowerCase()) return;
            onChangeColor(next).catch(() => {
              /* mutation's onError surfaces the toast */
            });
          }}
        />
        <span className="font-mono text-[10px] text-[color:var(--text-tertiary)] w-6">
          #{cls.idx}
        </span>
        {editing ? (
          <div className="flex-1 flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              maxLength={120}
              autoFocus
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              onBlur={() => {
                // Don't fire if the user is clicking the inline Save/Cancel
                // buttons — those handle the commit themselves. A small
                // setTimeout lets the click-handler win the race.
                setTimeout(() => {
                  if (document.activeElement !== inputRef.current && editing) {
                    void commitEdit();
                  }
                }, 0);
              }}
              aria-label={`Rename class ${cls.name}`}
              data-testid={`class-name-input-${cls.id}`}
              className={cn(
                "flex-1 min-w-0 h-7 px-2 text-[13px] tracking-tight",
                "bg-[var(--bg-elev)] text-[color:var(--text-primary)]",
                "rounded-[var(--radius-sm)] border border-[var(--accent)]",
                "focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-0",
                "disabled:opacity-60",
              )}
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void commitEdit()}
              disabled={saving}
              aria-label="Save class name"
              data-testid={`class-name-save-${cls.id}`}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                "text-[color:var(--accent)] hover:bg-[var(--accent-bg)]",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelEdit}
              disabled={saving}
              aria-label="Cancel rename"
              data-testid={`class-name-cancel-${cls.id}`}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={startEdit}
              onDoubleClick={startEdit}
              aria-label={`Rename class ${cls.name}`}
              data-testid={`class-name-${cls.id}`}
              className={cn(
                "flex-1 min-w-0 text-left text-[13px] tracking-tight text-[color:var(--text-primary)] truncate",
                "rounded-[var(--radius-xs)] px-1 -mx-1",
                "hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              )}
            >
              {cls.name}
            </button>
            <button
              type="button"
              onClick={startEdit}
              aria-label={`Rename class ${cls.name}`}
              data-testid={`class-rename-${cls.id}`}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]",
                "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity",
              )}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {/* v3.31 — IS-A hierarchy parent picker. Always visible so the
            relationship is never invisible; subtler when no parent is
            set so it doesn't compete with the class name. Server enforces
            same-project / no-cycle / depth limits; we also pre-filter
            descendants to make the dropdown UX clean. */}
        <ParentPickerPill
          cls={cls}
          allClasses={allClasses}
          onChangeParent={onChangeParent}
        />
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete class ${cls.name}`}
          className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--text-tertiary)] transition-colors hover:bg-[var(--danger-bg)] hover:text-[color:var(--danger)]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// v3.31 — Parent (IS-A) picker.
//
// Renders as a compact pill on the right side of each class row:
//   * "↑ Specialization of <Parent>" with the parent's color dot, when
//     parent_class_id is set.
//   * "↑ Parent" muted hint, when null.
//
// Clicking the pill opens a Popover with the eligible-parent list:
//   * "None (top-level)" at top.
//   * Every class in the project EXCEPT the row itself and any class
//     whose ancestor chain leads back to the row (cycle prevention —
//     mirrors the server-side check so the user gets immediate feedback
//     without a network round-trip).
//   * Indented by depth so multi-level hierarchies are scannable.
//
// Errors from the server (cycle / depth limit) surface via the parent's
// update mutation's onError toast handler.
// ---------------------------------------------------------------------------
interface ParentPickerPillProps {
  cls: ClassRow;
  allClasses: ReadonlyArray<ClassRow>;
  onChangeParent: (next: string | null) => Promise<unknown>;
}

function ParentPickerPill({
  cls,
  allClasses,
  onChangeParent,
}: ParentPickerPillProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const classMap = useRef<Map<string, ClassRow>>(new Map());
  classMap.current = new Map(allClasses.map((c) => [c.id, c]));

  // Descendants (self-inclusive) of ``cls`` — these can't be parents
  // of ``cls`` without creating a cycle.
  const ineligibleSelfAndDescendants = (() => {
    const out = new Set<string>([cls.id]);
    let frontier = [cls.id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const c of allClasses) {
        if (
          c.parent_class_id &&
          frontier.includes(c.parent_class_id) &&
          !out.has(c.id)
        ) {
          out.add(c.id);
          next.push(c.id);
        }
      }
      frontier = next;
    }
    return out;
  })();

  // Depth of each class (top-level = 0). Used to indent the dropdown.
  function depthOf(id: string): number {
    let depth = 0;
    let cur: ClassRow | undefined = classMap.current.get(id);
    const seen = new Set<string>();
    while (cur && cur.parent_class_id && !seen.has(cur.parent_class_id)) {
      seen.add(cur.parent_class_id);
      depth += 1;
      if (depth >= 8) break;
      cur = classMap.current.get(cur.parent_class_id);
    }
    return depth;
  }

  const eligible = allClasses
    .filter((c) => !ineligibleSelfAndDescendants.has(c.id))
    // Sort by hierarchy: parent before children, then by idx within
    // siblings. Simple approach — sort by (depth, idx).
    .map((c) => ({ cls: c, depth: depthOf(c.id) }))
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.cls.idx - b.cls.idx;
    });

  const parent = cls.parent_class_id
    ? classMap.current.get(cls.parent_class_id) ?? null
    : null;

  async function pick(next: string | null) {
    if (saving) return;
    if (next === (cls.parent_class_id ?? null)) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onChangeParent(next);
      setOpen(false);
    } catch {
      // The mutation's onError surfaces a toast; keep the popover open
      // so the user sees their pick didn't stick.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            parent
              ? `Change parent of ${cls.name} (currently ${parent.name})`
              : `Set a parent class for ${cls.name}`
          }
          data-testid={`class-parent-trigger-${cls.id}`}
          className={cn(
            "inline-flex items-center gap-1.5 h-6 px-2 rounded-[var(--radius-pill)] text-[11px] shrink-0 whitespace-nowrap",
            "border border-transparent transition-colors",
            "hover:bg-[var(--bg-hover)] hover:border-[var(--border-subtle)]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            parent
              ? "text-[color:var(--text-secondary)]"
              : "text-[color:var(--text-tertiary)] opacity-60 group-hover:opacity-100",
          )}
          title={
            parent
              ? `Specialization of ${parent.name} — auto-annotate will drop ${parent.name} boxes that overlap a ${cls.name} above the configured IoU floor.`
              : "Set a parent class (IS-A). Auto-annotate will drop ancestor annotations that overlap descendants."
          }
        >
          <span aria-hidden="true">↑</span>
          {parent ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: parent.color }}
              />
              <span className="truncate max-w-[140px]">{parent.name}</span>
            </>
          ) : (
            <span>Parent</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className={cn(
          "z-[1000] w-[280px] p-1",
          "rounded-[var(--radius-6)] bg-[var(--bg-elev)]",
          "border border-[var(--border-subtle)] shadow-[var(--shadow-card)]",
        )}
      >
        <div
          className="px-2 py-1.5 text-[10.5px] uppercase tracking-[0.10em] text-[color:var(--text-tertiary)] border-b border-[var(--border-subtle)] mb-1"
        >
          Parent of {cls.name}
        </div>
        <ul
          data-testid={`class-parent-list-${cls.id}`}
          className="max-h-[220px] overflow-y-auto"
        >
          <li>
            <button
              type="button"
              onClick={() => void pick(null)}
              data-testid={`class-parent-option-none-${cls.id}`}
              disabled={saving}
              className={cn(
                "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12px]",
                "hover:bg-[var(--bg-hover)]",
                cls.parent_class_id == null &&
                  "bg-[var(--accent-bg)] text-[color:var(--text-primary)]",
              )}
            >
              <span aria-hidden="true" className="text-[color:var(--text-tertiary)] w-3.5">
                {cls.parent_class_id == null ? "✓" : ""}
              </span>
              <span className="flex-1">None (top-level class)</span>
            </button>
          </li>
          {eligible.length === 0 && (
            <li className="px-2 py-2 text-[11.5px] italic text-[color:var(--text-tertiary)]">
              No other classes available — add a sibling class first.
            </li>
          )}
          {eligible.map(({ cls: opt, depth }) => {
            const selected = cls.parent_class_id === opt.id;
            return (
              <li key={opt.id}>
                <button
                  type="button"
                  onClick={() => void pick(opt.id)}
                  data-testid={`class-parent-option-${cls.id}-${opt.id}`}
                  disabled={saving}
                  className={cn(
                    "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[12px]",
                    "hover:bg-[var(--bg-hover)]",
                    selected &&
                      "bg-[var(--accent-bg)] text-[color:var(--text-primary)]",
                  )}
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                >
                  <span
                    aria-hidden="true"
                    className="text-[color:var(--text-tertiary)] w-3.5"
                  >
                    {selected ? "✓" : ""}
                  </span>
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ background: opt.color }}
                  />
                  <span className="flex-1 truncate" title={opt.name}>
                    {opt.name}
                  </span>
                  <span className="font-mono text-[10px] text-[color:var(--text-tertiary)]">
                    #{opt.idx}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// Swatch popover — preset palette + native custom picker, mirroring the
// add-class form's color UI. Selecting a color fires ``onChange`` even
// when the popover stays open so consumers can decide whether to close
// it (the dropdown closes naturally on outside click).
interface ClassColorPopoverProps {
  color: string;
  ariaLabel: string;
  onChange: (next: string) => void;
}

function ClassColorPopover({ color, ariaLabel, onChange }: ClassColorPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid="class-color-swatch"
          className={cn(
            "h-4 w-4 shrink-0 rounded-full border border-[var(--border-strong)]",
            "transition-transform hover:scale-110",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
          )}
          style={{ background: color }}
        />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="grid gap-2 p-2">
        <div className="grid grid-cols-6 gap-1">
          {PALETTE_HEX.map((c) => {
            const isSelected = c.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                aria-label={`Set color ${c}`}
                data-testid={`class-color-preset-${c}`}
                data-selected={isSelected ? "true" : undefined}
                onClick={() => onChange(c)}
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
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] pt-2">
          <span className="text-[11px] tracking-tight text-[color:var(--text-tertiary)]">
            Custom
          </span>
          <input
            type="color"
            aria-label="Custom color"
            data-testid="class-color-custom"
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="h-6 w-10 cursor-pointer rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-transparent p-0"
          />
        </div>
      </PopoverContent>
    </Popover>
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

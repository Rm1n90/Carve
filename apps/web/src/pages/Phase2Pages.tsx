import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  RotateCcw,
  Star,
  Trash2,
  Upload,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { SamVariantSwitcher } from "@/components/annotation/SamVariantSwitcher";
import {
  trashApi,
  weightsApi,
  type TrashItem,
  type Weight,
} from "@/api/phase2";
import { useAuth } from "@/auth/store";
import { showToast } from "@/lib/toast";
import { UploadWeightDialog } from "@/pages/UploadWeightDialog";

// =========================== /models/yolo ===========================

function bytesToMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

interface InlineNameProps {
  weight: Weight;
  canEdit: boolean;
  busy: boolean;
  onSubmit: (name: string) => void;
}

/**
 * Per-row inline rename for `Weight.name`. Pencil icon → input + check / X.
 * Enter commits, Esc cancels. Disabled when the user lacks edit permission
 * (only admin / project owner — same gate as delete).
 */
function InlineName({ weight, canEdit, busy, onSubmit }: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(weight.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      // Sync from latest weight if upstream changed while not editing.
      setDraft(weight.name);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [editing, weight.name]);

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === weight.name) {
      setEditing(false);
      setDraft(weight.name);
      return;
    }
    onSubmit(trimmed);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
    setDraft(weight.name);
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-medium tracking-tight" data-testid={`weight-name-${weight.id}`}>
          {weight.name}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy}
            data-testid={`weight-rename-${weight.id}`}
            aria-label={`Rename ${weight.name}`}
            className="grid h-6 w-6 place-items-center rounded text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        aria-label={`New name for ${weight.name}`}
        data-testid={`weight-rename-input-${weight.id}`}
        className="h-7 px-2 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--bg-elev)] text-[13px] tracking-tight outline-none focus:border-[var(--accent)] min-w-[140px]"
      />
      <button
        type="button"
        onClick={commit}
        disabled={busy}
        aria-label="Save name"
        data-testid={`weight-rename-save-${weight.id}`}
        className="grid h-6 w-6 place-items-center rounded text-[color:var(--success)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
      >
        <Check className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={cancel}
        aria-label="Cancel rename"
        className="grid h-6 w-6 place-items-center rounded text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export function ModelsYoloPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const wsQ = useQuery({
    queryKey: ["weights", "workspace"],
    queryFn: weightsApi.listWorkspace,
  });
  // v3.3 Issue 4 — defaults float to the top, then by newest. We sort a
  // copy so we don't mutate react-query's cache.
  const weights = (() => {
    const rows = wsQ.data ?? [];
    const sorted = [...rows].sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
    return sorted;
  })();
  const [uploadOpen, setUploadOpen] = useState(false);
  // v3.0 C6 — selected weight drives the right-side details panel. We
  // store the id rather than the object so it stays valid across
  // re-fetches (rows are replaced by reference but the id is stable).
  const [selectedWeightId, setSelectedWeightId] = useState<string | null>(
    null,
  );
  const selectedWeight =
    weights.find((w) => w.id === selectedWeightId) ?? null;

  const deleteM = useMutation({
    mutationFn: (id: string) => weightsApi.delete(id),
    onSuccess: () => {
      showToast("Weight deleted", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["weights"] });
      qc.invalidateQueries({ queryKey: ["weights", "workspace"] });
    },
    onError: (err: Error) => {
      showToast(err?.message ?? "Delete failed", { variant: "error" });
    },
  });

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      weightsApi.update(id, { name }),
    onSuccess: () => {
      showToast("Weight renamed", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["weights"] });
      qc.invalidateQueries({ queryKey: ["weights", "workspace"] });
    },
    onError: (err: Error) => {
      showToast(err?.message ?? "Rename failed", { variant: "error" });
    },
  });

  // v3.3 Issue 4 — flip a weight to "default" for its (project, task_kind).
  // The backend clears any sibling default in the same slot atomically.
  const setDefaultM = useMutation({
    mutationFn: (id: string) => weightsApi.setDefault(id),
    onSuccess: () => {
      showToast("Default weight updated", { variant: "success" });
      qc.invalidateQueries({ queryKey: ["weights"] });
      qc.invalidateQueries({ queryKey: ["weights", "workspace"] });
    },
    onError: (err: Error) => {
      showToast(err?.message ?? "Failed to set default", { variant: "error" });
    },
  });

  const canDelete = me?.role === "admin";

  async function handleDeleteWeight(w: Weight) {
    const ok = await confirm({
      title: "Delete weight?",
      description: (
        <>
          Permanently remove the weight{" "}
          <span className="font-medium text-[color:var(--text-primary)]">
            {w.name}
          </span>
          . This cannot be undone.
        </>
      ),
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (ok) {
      deleteM.mutate(w.id, {
        onSuccess: () => {
          // Drop selection if the deleted row was selected.
          setSelectedWeightId((prev) => (prev === w.id ? null : prev));
        },
      });
    }
  }

  return (
    // v3.0 C6 — full-width canvas (was capped at 1100px). The page now
    // uses the wide outer container so the table breathes on 1440+
    // screens and we can fit the right-side details panel without
    // squeezing the table columns.
    <div className="grid gap-6 max-w-screen-2xl">
      {/* v2.9 P1-16 — editorial header pattern. */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-1">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
            Models
          </span>
          <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
            YOLO weights
          </h1>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
            Custom YOLOv8 weights uploaded to this workspace. Pre-trained model
            zoo weights are managed by the model service.
          </p>
        </div>
        <Button
          variant="primary"
          size="md"
          leftIcon={<Upload className="h-4 w-4" />}
          onClick={() => setUploadOpen(true)}
          data-testid="upload-weight-trigger"
        >
          Upload weight
        </Button>
      </header>
      <UploadWeightDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      {/* v3.0 C6 — table on the left, details panel on the right at
          widescreen. Single column below `lg` so mobile / split-pane
          screens keep the panel below the table without squeezing. */}
      <div
        data-testid="yolo-page-grid"
        className="grid gap-6 lg:grid-cols-[1fr_320px]"
      >
        <Card variant="surface" radius="lg" className="overflow-hidden">
          {wsQ.isLoading ? (
            <p className="p-6 text-[13px] text-[color:var(--text-tertiary)]">
              Loading…
            </p>
          ) : weights.length === 0 ? (
            <div className="p-12 text-center grid gap-3 place-items-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)]">
                <Cpu className="h-5 w-5" />
              </span>
              <p className="text-[14px] font-medium tracking-tight">
                No custom YOLO weights yet
              </p>
              <p className="text-[12.5px] text-[color:var(--text-tertiary)] max-w-md">
                Upload a <code className="font-mono">.pt</code> file from a
                project's detail page to make it available for inference and
                auto-annotation.
              </p>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="bg-[var(--bg-subtle)] text-[12px] tracking-tight text-[color:var(--text-tertiary)]">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Name</th>
                  <th className="text-left font-medium px-4 py-2.5">Task</th>
                  <th className="text-left font-medium px-4 py-2.5">Classes</th>
                  <th className="text-right font-medium px-4 py-2.5">Size</th>
                  <th className="text-left font-medium px-4 py-2.5">Uploaded</th>
                  <th className="text-right font-medium px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {weights.map((w) => {
                  const isSelected = w.id === selectedWeightId;
                  return (
                    <tr
                      key={w.id}
                      // v3.0 C6 — click-to-select drives the right panel.
                      // The action buttons stop propagation so the row
                      // selection doesn't fight Edit/Delete.
                      onClick={() => setSelectedWeightId(w.id)}
                      data-testid={`weight-row-${w.id}`}
                      data-selected={isSelected ? "true" : undefined}
                      className={
                        "cursor-pointer border-t border-[var(--border-subtle)] " +
                        (isSelected
                          ? "bg-[var(--accent-bg)]"
                          : "hover:bg-[var(--bg-hover)]")
                      }
                    >
                      <td
                        className="px-4 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <InlineName
                            weight={w}
                            canEdit={canDelete}
                            busy={
                              renameM.isPending &&
                              renameM.variables?.id === w.id
                            }
                            onSubmit={(name) =>
                              renameM.mutate({ id: w.id, name })
                            }
                          />
                          {w.is_default && (
                            <span
                              data-testid={`weight-row-default-badge-${w.id}`}
                              title="Project default for this task kind"
                              aria-label="Default weight"
                              className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] px-1.5 py-0.5 text-[10px] font-medium tracking-tight"
                            >
                              <Star className="h-2.5 w-2.5 fill-current" />
                              Default
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="accent">{w.task_kind}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[color:var(--text-secondary)]">
                        {w.class_names.length}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[12px]">
                        {bytesToMb(w.size_bytes)}
                      </td>
                      <td className="px-4 py-2.5 text-[color:var(--text-tertiary)]">
                        {new Date(w.created_at).toLocaleDateString()}
                      </td>
                      <td
                        className="px-4 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-end">
                          <Button
                            size="sm"
                            variant="danger"
                            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                            disabled={!canDelete || deleteM.isPending}
                            data-testid={`weight-delete-${w.id}`}
                            onClick={() => {
                              void handleDeleteWeight(w);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* v3.0 C6 — right-side details panel. Glass card mirrors the
            existing surface treatment used elsewhere in v2.9. Empty
            selection shows muted helper text per the audit. */}
        <Card
          variant="surface"
          radius="lg"
          className="p-4 grid gap-3 self-start"
          data-testid="yolo-details-panel"
        >
          {selectedWeight ? (
            <>
              <div className="grid gap-1">
                <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
                  Selected weight
                </span>
                <p
                  className="text-[15px] font-medium tracking-tight truncate"
                  data-testid="yolo-details-name"
                >
                  {selectedWeight.name}
                </p>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
                <dt className="text-[color:var(--text-tertiary)]">Task</dt>
                <dd>
                  <Badge variant="accent">{selectedWeight.task_kind}</Badge>
                </dd>

                <dt className="text-[color:var(--text-tertiary)]">Size</dt>
                <dd className="font-mono text-[12px]">
                  {bytesToMb(selectedWeight.size_bytes)}
                </dd>

                <dt className="text-[color:var(--text-tertiary)]">Uploaded</dt>
                <dd className="text-[color:var(--text-secondary)]">
                  {new Date(selectedWeight.created_at).toLocaleString()}
                </dd>
              </dl>

              <div className="grid gap-1.5">
                <span className="text-[11px] tracking-tight text-[color:var(--text-tertiary)] uppercase">
                  Classes ({selectedWeight.class_names.length})
                </span>
                {selectedWeight.class_names.length === 0 ? (
                  <p className="text-[12px] text-[color:var(--text-tertiary)] italic">
                    No class metadata recorded for this weight.
                  </p>
                ) : (
                  <ul
                    className="flex flex-wrap gap-1"
                    data-testid="yolo-details-classes"
                  >
                    {selectedWeight.class_names.map((cn) => (
                      <li key={cn}>
                        <Badge variant="neutral">{cn}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* v3.5 Phase F4 — the per-weight class mapping editor moved
                  to the predict popover (where task context exists). One
                  weight can be predicted into many tasks, each with its own
                  allowed classes, so binding is intrinsically per-task and
                  no longer persisted on the weight itself. */}

              {/* v3.3 Issue 4 — default toggle. If currently default, show
                  a status pill; otherwise show a button to flip the slot. */}
              <div className="flex items-center justify-between gap-2 pt-1">
                {selectedWeight.is_default ? (
                  <span
                    data-testid="yolo-details-default-badge"
                    aria-label="This weight is the project default"
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-bg)] text-[color:var(--accent)] px-2 py-1 text-[11px] font-medium tracking-tight"
                  >
                    <Star className="h-3 w-3 fill-current" />
                    Default
                    <Check className="h-3 w-3" />
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Star className="h-3.5 w-3.5" />}
                    disabled={!canDelete || setDefaultM.isPending}
                    data-testid="yolo-details-set-default"
                    onClick={() => setDefaultM.mutate(selectedWeight.id)}
                  >
                    Set as default
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                  disabled={!canDelete || deleteM.isPending}
                  data-testid="yolo-details-delete"
                  onClick={() => {
                    void handleDeleteWeight(selectedWeight);
                  }}
                >
                  Delete
                </Button>
              </div>
            </>
          ) : (
            <p
              className="text-[12.5px] text-[color:var(--text-tertiary)]"
              data-testid="yolo-details-empty"
            >
              Select a weight to see details
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

// =========================== /models/sam ===========================

export function ModelsSamPage() {
  return (
    <div className="grid gap-6 max-w-[1100px]">
      {/* v2.9 P1-16 — editorial header pattern. */}
      <header className="grid gap-1">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          Models
        </span>
        <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
          SAM models
        </h1>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Segment Anything variants used by the auto-annotation pipeline.
        </p>
      </header>

      {/* v3.5 Phase B — render the shared switcher; the same widget is
          now used in the editor toolbar's compact picker. */}
      <SamVariantSwitcher variant="full" />
    </div>
  );
}

// =============================== /trash ===============================

export function TrashPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();

  const trashQ = useQuery({ queryKey: ["trash"], queryFn: trashApi.list });
  const restoreM = useMutation({
    mutationFn: ({ kind, id }: TrashItem) => trashApi.restore(kind, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const hardDeleteM = useMutation({
    mutationFn: ({ kind, id }: TrashItem) => trashApi.hardDelete(kind, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trash"] }),
  });

  const items = trashQ.data?.items ?? [];

  return (
    <div className="grid gap-6 max-w-[1100px]">
      {/* v2.9 P1-16 — editorial header pattern. */}
      <header className="grid gap-1">
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[color:var(--text-tertiary)]">
          Account
        </span>
        <h1 className="font-editorial text-[36px] leading-[0.95] text-[color:var(--text-primary)]">
          Trash
        </h1>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Soft-deleted projects and tasks. Restore to bring them back, or
          permanently delete (admin only).
        </p>
      </header>

      <Card variant="surface" radius="lg" className="overflow-hidden">
        {trashQ.isLoading ? (
          <p className="p-6 text-[13px] text-[color:var(--text-tertiary)]">Loading…</p>
        ) : items.length === 0 ? (
          <div className="p-12 text-center grid gap-3 place-items-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--bg-subtle)] text-[color:var(--text-tertiary)]">
              <Trash2 className="h-5 w-5" />
            </span>
            <p className="text-[14px] font-medium tracking-tight">Trash is empty</p>
            <p className="text-[12.5px] text-[color:var(--text-tertiary)]">
              Deleted items will appear here for recovery.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px]" data-testid="trash-table">
            <thead className="bg-[var(--bg-subtle)] text-[12px] tracking-tight text-[color:var(--text-tertiary)]">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Kind</th>
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5">Deleted</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={`${item.kind}-${item.id}`}
                  className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                >
                  <td className="px-4 py-2.5">
                    <Badge variant={item.kind === "project" ? "accent" : "neutral"}>
                      {item.kind}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 font-medium tracking-tight">
                    {item.name}
                  </td>
                  <td className="px-4 py-2.5 text-[color:var(--text-tertiary)]">
                    {new Date(item.deleted_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                        onClick={() => restoreM.mutate(item)}
                      >
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={me?.role !== "admin"}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Permanently delete ${item.kind}?`,
                            description: (
                              <>
                                This will permanently remove{" "}
                                <span className="font-medium text-[color:var(--text-primary)]">
                                  {item.name}
                                </span>{" "}
                                and cannot be undone.
                              </>
                            ),
                            variant: "danger",
                            confirmLabel: "Delete forever",
                          });
                          if (ok) hardDeleteM.mutate(item);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

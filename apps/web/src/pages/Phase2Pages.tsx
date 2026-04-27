import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Layers, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { trashApi, modelsApi, weightsApi, type TrashItem } from "@/api/phase2";
import { useAuth } from "@/auth/store";

// =========================== /models/yolo ===========================

function bytesToMb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

export function ModelsYoloPage() {
  const wsQ = useQuery({
    queryKey: ["weights", "workspace"],
    queryFn: weightsApi.listWorkspace,
  });
  const weights = wsQ.data ?? [];

  return (
    <div className="grid gap-6 max-w-[1100px]">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">YOLO weights</h1>
          <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
            Custom YOLOv8 weights uploaded to this workspace. Pre-trained model
            zoo weights are managed by the model service.
          </p>
        </div>
      </header>

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
              </tr>
            </thead>
            <tbody>
              {weights.map((w) => (
                <tr
                  key={w.id}
                  className="border-t border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                >
                  <td className="px-4 py-2.5 font-medium tracking-tight">
                    {w.name}
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// =========================== /models/sam ===========================

const SAM_VARIANT_LABEL: Record<string, string> = {
  "sam2.1-tiny": "SAM 2.1 — Tiny (39MB · fastest)",
  "sam2.1-small": "SAM 2.1 — Small",
  "sam2.1-base+": "SAM 2.1 — Base+",
  "sam2.1-large": "SAM 2.1 — Large (slowest · best)",
  sam3: "SAM 3 — concept-driven prompting",
};

export function ModelsSamPage() {
  const samQ = useQuery({ queryKey: ["sam-active"], queryFn: modelsApi.samActive });
  const data = samQ.data;

  return (
    <div className="grid gap-6 max-w-[1100px]">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">SAM models</h1>
        <p className="text-[13px] text-[color:var(--text-secondary)] mt-1">
          Segment Anything variants used by the auto-annotation pipeline.
        </p>
      </header>

      <Card variant="surface" radius="lg" className="p-6 grid gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] bg-[var(--accent-bg)] text-[color:var(--accent)]">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[12px] tracking-tight text-[color:var(--text-tertiary)] uppercase">
              Active variant
            </p>
            <p className="text-[18px] font-medium tracking-tight">
              {samQ.isLoading
                ? "…"
                : SAM_VARIANT_LABEL[data?.active ?? ""] ?? data?.active}
            </p>
          </div>
        </div>
      </Card>

      <Card variant="surface" radius="lg" className="overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-[14px] font-medium tracking-tight">
            Available variants
          </h2>
          <p className="text-[12px] text-[color:var(--text-tertiary)] mt-0.5">
            To switch, edit <code className="font-mono">SAM_MODEL</code> in the
            API <code className="font-mono">.env</code> and restart the model
            service.
          </p>
        </div>
        <ul>
          {(data?.available ?? []).map((variant) => {
            const active = variant === data?.active;
            return (
              <li
                key={variant}
                className={
                  "px-6 py-3 border-b border-[var(--border-subtle)] last:border-b-0 flex items-center gap-3 " +
                  (active ? "bg-[var(--accent-bg)]" : "")
                }
              >
                <Layers
                  className={
                    "h-3.5 w-3.5 " +
                    (active
                      ? "text-[color:var(--accent)]"
                      : "text-[color:var(--text-tertiary)]")
                  }
                />
                <span className="text-[13.5px] tracking-tight">
                  {SAM_VARIANT_LABEL[variant] ?? variant}
                </span>
                {active && (
                  <Badge variant="accent" className="ml-auto">
                    Active
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

// =============================== /trash ===============================

export function TrashPage() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();

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
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">Trash</h1>
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
                        onClick={() => {
                          if (
                            window.confirm(
                              `Permanently delete ${item.kind} "${item.name}"? This cannot be undone.`,
                            )
                          ) {
                            hardDeleteM.mutate(item);
                          }
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

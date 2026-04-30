import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import {
  weightsApi,
  type WeightAssignment,
} from "@/api/phase2";
import { projectsApi, type Project } from "@/api/projects";
import { Button } from "@/components/ui/Button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { showToast } from "@/lib/toast";

interface WeightAssignmentCellProps {
  weightId: string;
  weightProjectId: string | null;
  canEdit: boolean;
}

/**
 * v3.7.1 — inline assignment editor used as a column inside the YOLO
 * weights table. Replaces the v3.7 details-panel widget (per user
 * feedback: "I prefer assignment in the table row").
 *
 * Layout: existing-assignment chips followed by a "+" button. The button
 * opens a Radix Popover hosting a search-filtered, multi-select project
 * list (one checkbox per workspace project). Cancel discards local
 * edits; Save diffs the local set against the server state and fans out
 * the necessary `addAssignment` / `removeAssignment` calls in parallel.
 *
 * Workspace-wide weights (`weightProjectId === null`) render the
 * "Workspace-wide" label and skip the editor entirely — they are
 * already visible to every project.
 */
export function WeightAssignmentCell({
  weightId,
  weightProjectId,
  canEdit,
}: WeightAssignmentCellProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());

  const assignmentsQ = useQuery<WeightAssignment[]>({
    queryKey: ["weights", weightId, "assignments"],
    queryFn: () => weightsApi.getAssignments(weightId),
    enabled: weightProjectId !== null,
    staleTime: 30_000,
  });

  // Fetch all workspace projects for the multi-select. We share the
  // ["projects"] cache key with the rest of the page.
  const projectsQ = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list(),
    enabled: open,
    staleTime: 60_000,
  });

  const assignedSet = useMemo<Set<string>>(
    () => new Set((assignmentsQ.data ?? []).map((a) => a.project_id)),
    [assignmentsQ.data],
  );

  // Seed the draft from the currently-assigned set every time the
  // popover opens so prior cancelled edits don't leak back in.
  useEffect(() => {
    if (open) {
      setDraftIds(new Set(assignedSet));
      setQuery("");
    }
  }, [open, assignedSet]);

  const saveM = useMutation({
    mutationFn: async () => {
      const before = assignedSet;
      const after = draftIds;
      const toAdd: string[] = [];
      const toRemove: string[] = [];
      for (const id of after) {
        if (!before.has(id)) toAdd.push(id);
      }
      for (const id of before) {
        if (!after.has(id)) toRemove.push(id);
      }
      // Run mutations in parallel — backend endpoints are idempotent
      // and independent per (weight, project) pair.
      await Promise.all([
        ...toAdd.map((pid) => weightsApi.addAssignment(weightId, pid)),
        ...toRemove.map((pid) => weightsApi.removeAssignment(weightId, pid)),
      ]);
      return { added: toAdd.length, removed: toRemove.length };
    },
    onSuccess: ({ added, removed }) => {
      if (added === 0 && removed === 0) {
        showToast("No changes", { variant: "info" });
      } else {
        showToast(
          `Updated assignments — +${added} / -${removed}`,
          { variant: "success" },
        );
      }
      qc.invalidateQueries({
        queryKey: ["weights", weightId, "assignments"],
      });
      qc.invalidateQueries({ queryKey: ["weights"] });
      setOpen(false);
    },
    onError: (err: Error) => {
      showToast(err?.message ?? "Failed to update assignments", {
        variant: "error",
      });
    },
  });

  // Workspace-wide weights are visible everywhere — no per-project chips.
  if (weightProjectId === null) {
    return (
      <span
        className="text-[11.5px] text-[color:var(--text-tertiary)] italic"
        data-testid={`weight-assignments-cell-${weightId}`}
      >
        Workspace-wide
      </span>
    );
  }

  const chips = assignmentsQ.data ?? [];
  const allProjects = projectsQ.data ?? [];
  const filteredProjects = (() => {
    const q = query.trim().toLowerCase();
    // Hide the weight's own scoped project — already implicitly visible.
    const visible = allProjects.filter((p) => p.id !== weightProjectId);
    if (!q) return visible;
    return visible.filter((p) => p.name.toLowerCase().includes(q));
  })();

  function toggleDraft(projectId: string) {
    setDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid={`weight-assignments-cell-${weightId}`}
    >
      {chips.map((a) => (
        <span
          key={a.project_id}
          data-testid={`weight-assignment-chip-${weightId}-${a.project_id}`}
          className="inline-flex items-center rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-secondary)] tracking-tight"
        >
          {a.project_name}
        </span>
      ))}
      {chips.length === 0 && (
        <span className="text-[11.5px] text-[color:var(--text-tertiary)] italic">
          —
        </span>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={!canEdit}
            data-testid={`weight-assignments-trigger-${weightId}`}
            aria-label="Edit assigned projects"
            className="ml-1 grid h-5 w-5 place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-elev)] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)] disabled:opacity-40"
            onClick={(e) => e.stopPropagation()}
          >
            <Plus className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          className="w-[280px] p-2"
        >
          <div
            className="grid gap-2"
            data-testid={`weight-assignments-popover-${weightId}`}
            // Stop click propagation so picking inside the popover
            // doesn't toggle row selection underneath.
            onClick={(e) => e.stopPropagation()}
          >
            <label className="flex items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--bg-elev)] px-2">
              <Search className="h-3 w-3 text-[color:var(--text-tertiary)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects…"
                aria-label="Search projects"
                data-testid={`weight-assignments-search-${weightId}`}
                className="h-7 flex-1 bg-transparent text-[12.5px] outline-none"
              />
            </label>
            <div
              className="max-h-[220px] overflow-y-auto"
              data-testid={`weight-assignments-list-${weightId}`}
            >
              {projectsQ.isLoading ? (
                <p className="px-2 py-1 text-[12px] text-[color:var(--text-tertiary)]">
                  Loading…
                </p>
              ) : filteredProjects.length === 0 ? (
                <p className="px-2 py-1 text-[12px] text-[color:var(--text-tertiary)] italic">
                  No projects match.
                </p>
              ) : (
                <ul className="grid gap-0.5">
                  {filteredProjects.map((p) => {
                    const checked = draftIds.has(p.id);
                    return (
                      <li key={p.id}>
                        <label
                          className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1 hover:bg-[var(--bg-hover)]"
                          data-testid={`weight-assignments-option-${weightId}-${p.id}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDraft(p.id)}
                            data-testid={`weight-assignments-checkbox-${weightId}-${p.id}`}
                            className="h-3.5 w-3.5 accent-[var(--accent)]"
                          />
                          <span className="flex-1 text-[12.5px] truncate">
                            {p.name}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-end gap-1.5 border-t border-[var(--border-subtle)] pt-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid={`weight-assignments-cancel-${weightId}`}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={saveM.isPending}
                data-testid={`weight-assignments-save-${weightId}`}
                onClick={() => saveM.mutate()}
              >
                Save
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

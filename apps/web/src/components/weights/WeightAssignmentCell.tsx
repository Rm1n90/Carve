// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Star } from "lucide-react";
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
 * v3.7.10 — popover lists ALL workspace projects (no longer filters
 * out the weight's own legacy `project_id`); the legacy project is
 * rendered as a "default" chip and pre-checked in the popover.
 * Workspace-wide weights (`weightProjectId === null`) also support
 * per-project assignments — they no longer short-circuit out of the
 * editor.
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
    enabled: true,
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
  // popover opens so prior cancelled edits don't leak back in. The
  // legacy `project_id` is also pre-checked so users see it as the
  // weight's "default" home in the picker.
  useEffect(() => {
    if (open) {
      const initial = new Set(assignedSet);
      if (weightProjectId !== null) {
        initial.add(weightProjectId);
      }
      setDraftIds(initial);
      setQuery("");
    }
  }, [open, assignedSet, weightProjectId]);

  const saveM = useMutation({
    mutationFn: async () => {
      // Build the effective "before" set used for diffing. We include
      // the legacy project here because the popover seeds the draft
      // with it pre-checked — so leaving it checked must be a no-op
      // (not a phantom add). Unchecking it still produces a remove,
      // which the backend treats as idempotent if no row exists.
      const before = new Set(assignedSet);
      if (weightProjectId !== null) {
        before.add(weightProjectId);
      }
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

  const assignmentsList = assignmentsQ.data ?? [];
  const allProjects = projectsQ.data ?? [];

  // Find the legacy project's name from the projects list (best-effort).
  // Only resolved once the popover (and therefore the projects list)
  // has been opened at least once. Until then we fall back to the
  // assignment row's name (if present) or a placeholder.
  const legacyProject =
    weightProjectId !== null
      ? allProjects.find((p) => p.id === weightProjectId) ?? null
      : null;

  // Build display chips: legacy first (marked as default), then
  // assignments. Dedupe in case the legacy project was also explicitly
  // assigned.
  const displayChips: Array<{
    project_id: string;
    project_name: string;
    isDefault: boolean;
  }> = [];
  if (legacyProject) {
    displayChips.push({
      project_id: legacyProject.id,
      project_name: legacyProject.name,
      isDefault: true,
    });
  } else if (weightProjectId !== null) {
    // Projects list not loaded yet — synthesize the default chip from
    // any matching assignment row, otherwise show a generic label.
    const fromAssignments = assignmentsList.find(
      (a) => a.project_id === weightProjectId,
    );
    displayChips.push({
      project_id: weightProjectId,
      project_name: fromAssignments?.project_name ?? "Default project",
      isDefault: true,
    });
  }
  for (const a of assignmentsList) {
    if (a.project_id === weightProjectId) continue; // already added as legacy
    displayChips.push({
      project_id: a.project_id,
      project_name: a.project_name,
      isDefault: false,
    });
  }

  const filteredProjects = (() => {
    const q = query.trim().toLowerCase();
    // Show ALL workspace projects — including the weight's legacy
    // project (it's pre-checked). This keeps the picker functional
    // for single-project workspaces.
    if (!q) return allProjects;
    return allProjects.filter((p) => p.name.toLowerCase().includes(q));
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
      {displayChips.map((c) => (
        <span
          key={c.project_id}
          data-testid={`weight-assignment-chip-${weightId}-${c.project_id}`}
          data-default={c.isDefault ? "true" : undefined}
          title={c.isDefault ? "Default project (weight owner)" : undefined}
          className={
            c.isDefault
              ? "inline-flex items-center gap-1 rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11.5px] font-medium text-[color:var(--text-primary)] tracking-tight"
              : "inline-flex items-center rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11.5px] text-[color:var(--text-secondary)] tracking-tight"
          }
        >
          {c.isDefault && (
            <Star
              className="h-2.5 w-2.5 text-[color:var(--accent)]"
              data-testid={`weight-assignment-default-marker-${weightId}-${c.project_id}`}
              aria-label="Default project"
            />
          )}
          {c.project_name}
        </span>
      ))}
      {displayChips.length === 0 && (
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
                    const isLegacy = p.id === weightProjectId;
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
                          {isLegacy && (
                            <Star
                              className="h-2.5 w-2.5 text-[color:var(--accent)]"
                              aria-label="Default project"
                            />
                          )}
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

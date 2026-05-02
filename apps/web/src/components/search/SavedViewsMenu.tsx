// Armin Mehri — mehri.armin@gmail.com
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronDown, Eye, Plus } from "lucide-react";
import {
  viewsApi,
  type SavedView,
  type SavedViewQuery,
} from "@/api/views";
import { cn } from "@/lib/cn";

interface SavedViewsMenuProps {
  taskId: string;
  /** Current filter snapshot for "Save current view". */
  currentQuery: SavedViewQuery;
  /** ID of the currently active view, if any. Highlights the active row. */
  activeViewId?: string | null;
  /** Called when the user picks a view; receives the view to apply. */
  onSelect: (view: SavedView) => void;
}

/**
 * Plan-13 Phase 7 Task 9 — saved views pill rendered in the editor.
 *
 * Lists the user's own views + any shared views for the current task,
 * with a "Save current view" entry at the bottom that opens a small
 * Radix Dialog prompting for a name and a shared toggle before POSTing.
 */
export function SavedViewsMenu({
  taskId,
  currentQuery,
  activeViewId,
  onSelect,
}: SavedViewsMenuProps) {
  const qc = useQueryClient();
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftShared, setDraftShared] = useState(false);

  const q = useQuery({
    queryKey: ["views", taskId],
    queryFn: () => viewsApi.list(taskId),
  });

  const create = useMutation({
    mutationFn: () =>
      viewsApi.create(taskId, {
        name: draftName.trim(),
        query: currentQuery,
        shared: draftShared,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["views", taskId] });
      setSaveOpen(false);
      setDraftName("");
      setDraftShared(false);
    },
  });

  const items = q.data ?? [];

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="saved-views-trigger"
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full",
              "glass-chip text-[12px] tracking-tight",
              "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            Views
            <ChevronDown className="h-3 w-3 text-[color:var(--text-tertiary)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            data-testid="saved-views-menu"
            align="end"
            sideOffset={6}
            className={cn(
              "min-w-[220px] rounded-[var(--radius-md)]",
              "glass-surface-strong p-1 z-50",
            )}
          >
            {items.length === 0 && (
              <p className="px-2 py-1.5 text-[11.5px] text-[color:var(--text-tertiary)]">
                No saved views yet.
              </p>
            )}
            {items.map((v) => (
              <DropdownMenu.Item
                key={v.id}
                data-testid={`saved-view-item-${v.id}`}
                onSelect={(e) => {
                  e.preventDefault();
                  onSelect(v);
                }}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px]",
                  "hover:bg-[var(--bg-hover)] cursor-pointer outline-none",
                  v.id === activeViewId && "text-[color:var(--accent)]",
                )}
              >
                <span className="flex-1 truncate">{v.name}</span>
                {v.shared && (
                  <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-tertiary)]">
                    shared
                  </span>
                )}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
            <DropdownMenu.Item
              data-testid="saved-views-save-current"
              onSelect={(e) => {
                e.preventDefault();
                setSaveOpen(true);
              }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-xs)] text-[13px] hover:bg-[var(--bg-hover)] cursor-pointer outline-none"
            >
              <Plus className="h-3.5 w-3.5" />
              Save current view
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DialogPrimitive.Root open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[900] bg-[rgba(15,23,42,0.32)]" />
          <DialogPrimitive.Content
            data-testid="saved-views-save-dialog"
            style={{ transform: "translate(-50%, -50%)" }}
            className={cn(
              "fixed left-1/2 top-1/2 z-[901]",
              "w-[min(92vw,420px)] rounded-[var(--radius-lg)]",
              "glass-surface-strong p-5 outline-none",
            )}
          >
            <DialogPrimitive.Title className="text-[15px] font-medium tracking-tight">
              Save view
            </DialogPrimitive.Title>
            <form
              className="grid gap-3 mt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (draftName.trim().length === 0) return;
                create.mutate();
              }}
            >
              <label className="grid gap-1 text-[12.5px]">
                Name
                <input
                  data-testid="saved-views-name-input"
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="h-8 px-2 rounded-[var(--radius-xs)] bg-[var(--bg-subtle)] outline-none text-[13px]"
                  autoFocus
                />
              </label>
              <label className="inline-flex items-center gap-2 text-[12.5px]">
                <input
                  data-testid="saved-views-shared-toggle"
                  type="checkbox"
                  checked={draftShared}
                  onChange={(e) => setDraftShared(e.target.checked)}
                />
                Share with project
              </label>
              <div className="flex justify-end gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setSaveOpen(false)}
                  className="h-8 px-3 rounded-full text-[12px] hover:bg-[var(--bg-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="saved-views-save-submit"
                  disabled={create.isPending || draftName.trim().length === 0}
                  className={cn(
                    "h-8 px-3 rounded-full text-[12px] font-medium",
                    "bg-[var(--accent)] text-[color:var(--accent-fg)]",
                    "disabled:bg-[var(--bg-subtle)] disabled:text-[color:var(--text-tertiary)]",
                  )}
                >
                  Save
                </button>
              </div>
            </form>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

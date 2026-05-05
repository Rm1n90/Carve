// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CheckSquare, Folder, Search } from "lucide-react";
import { projectsApi, type Project } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { MOD_LABEL } from "@/lib/platform";
import { cn } from "@/lib/cn";

/**
 * Item 5 — workspace-wide command palette.
 *
 * Mounts at the root level so the Cmd/Ctrl-K keybinding works on every
 * page. The corpus is now PROJECTS + TASKS only (assets dropped) so
 * users navigate to the right scope first and pick assets inside the
 * task page.
 */
type SearchItem =
  | {
      kind: "project";
      id: string;
      name: string;
      subtitle: string;
    }
  | {
      kind: "task";
      id: string;
      projectId: string;
      projectName: string;
      name: string;
      subtitle: string;
    };

async function loadCorpus(): Promise<SearchItem[]> {
  const projects = await projectsApi.list();
  const tasksByProject = await Promise.all(
    projects.map(async (p): Promise<{
      project: Project;
      tasks: Awaited<ReturnType<typeof tasksApi.listForProject>>;
    }> => ({
      project: p,
      tasks: await tasksApi.listForProject(p.id).catch(() => []),
    })),
  );
  const items: SearchItem[] = [];
  for (const { project, tasks } of tasksByProject) {
    items.push({
      kind: "project",
      id: project.id,
      name: project.name,
      subtitle: project.owner_email ?? "Project",
    });
    for (const t of tasks) {
      items.push({
        kind: "task",
        id: t.id,
        projectId: project.id,
        projectName: project.name,
        name: t.name,
        subtitle: `${project.name} · Task`,
      });
    }
  }
  return items;
}

export function GlobalSearchBar() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const navigate = useNavigate();

  // Cmd/Ctrl-K toggles the palette globally.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const corpusQ = useQuery({
    queryKey: ["global-search-corpus"],
    queryFn: loadCorpus,
    enabled: open,
    staleTime: 60_000,
  });
  const corpus = corpusQ.data ?? [];

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return corpus.slice(0, 30);
    return corpus
      .filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.subtitle.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [corpus, text]);

  function navigateToItem(item: SearchItem): void {
    setOpen(false);
    setText("");
    if (item.kind === "project") {
      void navigate({ to: `/projects/${item.id}` });
    } else {
      void navigate({
        to: `/projects/${item.projectId}/tasks/${item.id}`,
      });
    }
    // Item 5 — scroll the document and any inner <main> back to the
    // top so the user lands at the top of the destination instead of
    // wherever they had scrolled in the previous view.
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      const main = document.querySelector("main");
      if (main && typeof main.scrollTo === "function") {
        main.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      }
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="global-search-trigger"
        onClick={() => setOpen(true)}
        className={cn(
          "relative z-10 flex items-center gap-2 h-7 px-2 rounded-full",
          "glass-chip text-[12.5px] tracking-tight",
          "text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        )}
        aria-label="Open search (Cmd-K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search…</span>
        <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-mono text-[color:var(--text-tertiary)]">
          <kbd className="rounded border border-[var(--border-subtle)] px-1">{MOD_LABEL}</kbd>
          <kbd className="rounded border border-[var(--border-subtle)] px-1">K</kbd>
        </span>
      </button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[900] bg-[rgba(15,23,42,0.32)]" />
          <DialogPrimitive.Content
            data-testid="global-search-dialog"
            style={{ transform: "translate(-50%, -50%)" }}
            className={cn(
              "fixed left-1/2 top-1/3 z-[901]",
              "w-[min(92vw,640px)] max-h-[70vh] overflow-hidden",
              "rounded-[var(--radius-lg)] p-3 outline-none",
              "bg-[var(--bg-elev)] border border-[var(--border-subtle)]",
              "shadow-[var(--shadow-card)]",
            )}
          >
            <DialogPrimitive.Title className="sr-only">
              Search projects and tasks
            </DialogPrimitive.Title>
            <SearchInput
              value={text}
              onChange={setText}
              onEnter={() => filtered.length > 0 && navigateToItem(filtered[0])}
            />
            <div
              data-testid="global-search-results"
              className="max-h-[50vh] overflow-y-auto"
            >
              {corpusQ.isLoading && (
                <p className="px-3 py-4 text-[12px] text-[color:var(--text-tertiary)]">
                  Loading workspace…
                </p>
              )}
              {!corpusQ.isLoading && filtered.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-[color:var(--text-tertiary)]">
                  No matching projects or tasks.
                </p>
              )}
              <ul className="m-0 p-0 list-none">
                {filtered.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <button
                      type="button"
                      data-testid={`global-search-result-${item.id}`}
                      onClick={() => navigateToItem(item)}
                      className={cn(
                        "flex w-full items-center gap-3 px-2 py-2 rounded-[var(--radius-xs)]",
                        "hover:bg-[var(--bg-hover)] text-left",
                      )}
                    >
                      <span className="grid h-7 w-7 place-items-center rounded-[var(--radius-xs)] bg-[var(--bg-subtle)] shrink-0 text-[color:var(--text-tertiary)]">
                        {item.kind === "project" ? (
                          <Folder className="h-3.5 w-3.5" />
                        ) : (
                          <CheckSquare className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="flex flex-col min-w-0">
                        <span className="text-[13px] truncate text-[color:var(--text-primary)]">
                          {item.name}
                        </span>
                        <span className="text-[11px] truncate text-[color:var(--text-tertiary)]">
                          {item.subtitle}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

function SearchInput({
  value,
  onChange,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-2 px-2 py-2 border-b border-[var(--border-subtle)]">
      <Search className="h-4 w-4 text-[color:var(--text-tertiary)]" />
      <input
        ref={ref}
        data-testid="global-search-input"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder="Search projects and tasks…"
        className={cn(
          "flex-1 bg-transparent outline-none text-[14px]",
          "text-[color:var(--text-primary)] placeholder:text-[color:var(--text-tertiary)]",
        )}
      />
    </div>
  );
}

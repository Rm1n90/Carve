import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, FolderPlus } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { ProjectCard } from "@/components/ProjectCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

export function ProjectsPage() {
  const qc = useQueryClient();
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projectsApi.list });
  const createM = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const deleteM = useMutation({
    mutationFn: projectsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await createM.mutateAsync({ name, description: description || undefined });
    setShowForm(false);
    setName("");
    setDescription("");
  }

  const projects = projectsQ.data ?? [];

  return (
    <div className="mx-auto grid max-w-[1100px] gap-5">
      {/* ---- Header ---- */}
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="grid gap-0.5">
          <h1 className="text-[20px] font-medium tracking-tight text-[color:var(--text-primary)]">
            Projects
          </h1>
          <p className="text-[12.5px] text-[color:var(--text-tertiary)]">
            Carve datasets and annotation workspaces.
          </p>
        </div>
        <Button
          variant={showForm ? "secondary" : "success"}
          size="md"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "New project"}
        </Button>
      </header>

      {/* ---- Inline create form ---- */}
      {showForm && (
        <form
          onSubmit={onSubmit}
          className={cn(
            "grid gap-3 sm:grid-cols-[1fr_2fr_auto] items-end",
            "rounded-[var(--radius-md)] border border-[var(--border-subtle)]",
            "bg-[var(--bg-elev)] p-4",
          )}
        >
          <Input
            label="Name"
            required
            minLength={1}
            maxLength={120}
            placeholder="Carve project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Description"
            maxLength={4000}
            placeholder="What's this project about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={createM.isPending}>
            {createM.isPending ? "Creating" : "Create"}
          </Button>
        </form>
      )}

      {/* ---- States ---- */}
      {projectsQ.isLoading && (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[56px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-subtle)] animate-pulse"
            />
          ))}
        </div>
      )}
      {projectsQ.error && (
        <p className="text-[color:var(--danger)] text-[13px]">Failed to load projects.</p>
      )}

      {!projectsQ.isLoading && projects.length === 0 && (
        <div
          className={cn(
            "grid place-items-center gap-2 px-6 py-14",
            "rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)]",
            "bg-[var(--bg-subtle)]",
          )}
        >
          <FolderPlus className="h-6 w-6 text-[color:var(--text-tertiary)]" aria-hidden />
          <span className="text-[14px] font-medium text-[color:var(--text-primary)]">
            No projects yet
          </span>
          <span className="text-[12.5px] text-[color:var(--text-tertiary)]">
            Create your first project to start annotating.
          </span>
          <div className="mt-1">
            <Button
              variant="success"
              size="md"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setShowForm(true)}
            >
              New project
            </Button>
          </div>
        </div>
      )}

      {projects.length > 0 && (
        <section
          className={cn(
            "rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] overflow-hidden",
          )}
        >
          {/* Header row */}
          <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)]">
            <span className="text-[11px] uppercase tracking-[0.06em] text-[color:var(--text-tertiary)] font-medium">
              Name
            </span>
            <span className="text-[11px] uppercase tracking-[0.06em] text-[color:var(--text-tertiary)] font-medium pr-1">
              Actions
            </span>
          </div>
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onDelete={() => deleteM.mutate(p.id)} />
          ))}
        </section>
      )}
    </div>
  );
}

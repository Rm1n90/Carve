import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, FolderPlus } from "lucide-react";
import { projectsApi } from "@/api/projects";
import { ProjectCard } from "@/components/ProjectCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
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
    <div className="mx-auto grid max-w-[1200px] gap-10">
      {/* ---- Editorial header ---- */}
      <header className="flex items-end justify-between gap-6 flex-wrap">
        <div className="grid gap-2">
          <h1 className="editorial text-[44px] sm:text-[56px] text-primary">Projects.</h1>
          <p className="text-[15px] text-tertiary tracking-tight max-w-[520px]">
            Carve datasets and annotation workspaces. Each project owns its classes, tasks, and
            annotators.
          </p>
        </div>
        <Button
          variant={showForm ? "secondary" : "primary"}
          size="md"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Cancel" : "New project"}
        </Button>
      </header>

      {/* ---- Inline create form ---- */}
      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div
            key="form"
            initial={{ opacity: 0, y: -6, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -6, height: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <Card variant="raised" className="p-6">
              <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_2fr_auto] items-end">
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
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- States: loading, error, empty, grid ---- */}
      {projectsQ.isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[180px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] animate-pulse"
            />
          ))}
        </div>
      )}
      {projectsQ.error && (
        <p className="text-[var(--danger)] text-sm">Failed to load projects.</p>
      )}

      {!projectsQ.isLoading && projects.length === 0 && (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className={cn(
            "group grid place-items-center gap-3 px-6 py-16",
            "rounded-[var(--radius-xl)] border-2 border-dashed border-[var(--border-subtle)]",
            "bg-[oklch(0.18_0.012_240_/_0.30)]",
            "transition-all hover:border-[var(--border-accent)] hover:bg-[var(--accent-bg)]",
            "text-tertiary hover:text-primary",
          )}
        >
          <FolderPlus className="h-8 w-8 transition-colors group-hover:text-[var(--accent)]" />
          <div className="grid gap-1 text-center">
            <span className="text-[18px] font-medium tracking-tight text-primary">
              No projects yet
            </span>
            <span className="text-[13px]">Create your first project to start annotating.</span>
          </div>
        </button>
      )}

      {projects.length > 0 && (
        <motion.div
          className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.04 } },
          }}
        >
          {projects.map((p) => (
            <motion.div
              key={p.id}
              variants={{
                hidden: { opacity: 0, y: 12 },
                visible: {
                  opacity: 1,
                  y: 0,
                  transition: {
                    duration: 0.32,
                    ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
                  },
                },
              }}
            >
              <ProjectCard project={p} onDelete={() => deleteM.mutate(p.id)} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

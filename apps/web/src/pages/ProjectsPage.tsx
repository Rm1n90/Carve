import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "@/api/projects";
import { ProjectCard } from "@/components/ProjectCard";

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

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 960, margin: "0 auto" }}>
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <h1 style={{ margin: 0 }}>Projects</h1>
        <button onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New project"}
        </button>
      </header>

      {showForm && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await createM.mutateAsync({ name, description: description || undefined });
            setShowForm(false);
            setName("");
            setDescription("");
          }}
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
          }}
        >
          <label>
            Name
            <input
              required
              minLength={1}
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description
            <input
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <button type="submit" disabled={createM.isPending}>
            {createM.isPending ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      {projectsQ.isLoading && <p>Loading…</p>}
      {projectsQ.error && <p>Failed to load projects.</p>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        {projectsQ.data?.map((p) => (
          <ProjectCard key={p.id} project={p} onDelete={() => deleteM.mutate(p.id)} />
        ))}
      </div>
    </div>
  );
}

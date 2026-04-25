import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { classesApi, type ClassRow } from "@/api/classes";

export function ClassesEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });
  const create = useMutation({
    mutationFn: (input: { idx: number; name: string; color: string }) =>
      classesApi.create(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });
  const remove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState("#ff0000");
  const nextIdx = (q.data ?? []).reduce((m, c) => Math.max(m, c.idx + 1), 0);

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0 }}>Classes</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await create.mutateAsync({ idx: nextIdx, name, color });
          setName("");
        }}
        style={{ display: "flex", gap: 8, alignItems: "end" }}
      >
        <label style={{ flex: 1 }}>
          Class name
          <input
            required
            minLength={1}
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add class"}
        </button>
      </form>

      {q.isLoading && <p>Loading…</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
        {q.data?.map((c: ClassRow) => (
          <li
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 12px",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
            }}
          >
            <span
              aria-label={`Class ${c.idx} color`}
              style={{
                width: 18,
                height: 18,
                background: c.color,
                borderRadius: 4,
                border: "1px solid rgba(255,255,255,0.2)",
              }}
            />
            <span style={{ width: 32, opacity: 0.6 }}>#{c.idx}</span>
            <span style={{ flex: 1 }}>{c.name}</span>
            <button
              onClick={() => {
                if (confirm(`Delete class "${c.name}"?`)) remove.mutate(c.id);
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

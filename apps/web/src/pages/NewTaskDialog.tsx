import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tasksApi, type TaskKind } from "@/api/tasks";

export function NewTaskDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TaskKind>("image");
  const create = useMutation({
    mutationFn: () => tasksApi.create(projectId, { name, kind }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", projectId] });
      setName("");
      onCreated();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      style={{ display: "flex", gap: 8, alignItems: "end" }}
    >
      <label style={{ flex: 1 }}>
        Task name
        <input
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
          <option value="image">Image set</option>
          <option value="video">Video</option>
        </select>
      </label>
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Add task"}
      </button>
    </form>
  );
}

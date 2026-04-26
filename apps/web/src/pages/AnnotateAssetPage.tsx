import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { CommandPalette } from "@/components/annotation/CommandPalette";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { Toolbar } from "@/components/annotation/Toolbar";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import { classesApi } from "@/api/classes";
import { useAnnotations } from "@/state/annotations";

interface Props {
  projectId: string;
  taskId: string;
  assetId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 2000;

export function AnnotateAssetPage({ projectId, taskId, assetId }: Props) {
  const qc = useQueryClient();
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);
  const assetQ = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => assetsApi.get(assetId),
  });
  const classesQ = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });

  // For images, the single Frame for the asset. We resolve frameId by fetching annotations
  // (which includes frame_id) — but the simplest path is to load all annotations for the task
  // unfiltered and pick the ones for this asset's frame. For v1 image flow, we treat the
  // frame_id as null on the client and let the server resolve via the Frame row.
  const frameId: string | null = null;

  const annotationsQ = useQuery({
    queryKey: ["annotations", taskId, frameId],
    queryFn: async () => annotationsApi.listForTask(taskId, frameId ?? undefined),
  });

  // Seed the store on first load + when annotations change identity
  useEffect(() => {
    if (annotationsQ.data) {
      useAnnotations.getState().reset(annotationsQ.data);
    }
  }, [annotationsQ.data]);

  // Reactive dirty count from store
  const byId = useAnnotations((s) => s.byId);
  const pendingDeletes = useAnnotations((s) => s.pendingDeletes);
  const dirtyCount =
    Object.values(byId).filter((d) => d.dirty).length + pendingDeletes.length;

  const saveMutation = useMutation({
    mutationFn: (payload: BatchPayload) => annotationsApi.batch(taskId, payload),
    onSuccess: (res, variables) => {
      // Replace tempIds with serverIds; clear pendingDeletes
      const created = res.created;
      const sentCreates = variables.create;
      // Pair created drafts (ordered) by index — server returns in same order as request
      const sentTemp = Object.values(useAnnotations.getState().byId)
        .filter((a) => a.serverId === null && a.dirty)
        .slice(0, sentCreates.length);
      sentTemp.forEach((draft, i) => {
        const server = created[i];
        if (server) useAnnotations.getState().markPersisted(draft.tempId, server.id);
      });
      // Mark updated drafts as non-dirty
      res.updated.forEach((u) => {
        useAnnotations.setState((s) => ({
          byId: {
            ...s.byId,
            [u.id]: s.byId[u.id] ? { ...s.byId[u.id], dirty: false } : s.byId[u.id],
          },
        }));
      });
      useAnnotations.getState().clearPendingDeletes();
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
    },
  });

  // Build a payload from the current store state
  function buildPayload(): BatchPayload {
    const drafts = Object.values(useAnnotations.getState().byId);
    const create = drafts
      .filter((d) => d.serverId === null && d.dirty)
      .map((d) => ({
        frame_id: d.frameId,
        class_id: d.classId,
        kind: d.kind,
        geometry: d.geometry as unknown as Record<string, unknown>,
        track_id: null,
      }));
    const update = drafts
      .filter((d) => d.serverId !== null && d.dirty)
      .map((d) => ({
        id: d.serverId!,
        geometry: d.geometry as unknown as Record<string, unknown>,
        class_id: d.classId,
      }));
    return {
      create,
      update,
      delete: useAnnotations.getState().pendingDeletes,
    };
  }

  function saveNow() {
    const payload = buildPayload();
    if (
      payload.create.length === 0 &&
      payload.update.length === 0 &&
      payload.delete.length === 0
    ) {
      return;
    }
    saveMutation.mutate(payload);
  }

  // Debounced autosave on store changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = useAnnotations.subscribe((s, prev) => {
      if (s.byId === prev.byId && s.pendingDeletes === prev.pendingDeletes) return;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        saveNow();
      }, AUTOSAVE_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual Cmd+S
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveNow();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (assetQ.isLoading || classesQ.isLoading) {
    return <p>Loading…</p>;
  }
  if (assetQ.error || !assetQ.data) {
    return <p style={{ color: "tomato" }}>Failed to load asset.</p>;
  }

  const asset = assetQ.data.asset;
  const url = assetQ.data.url;
  const w = asset.width ?? 1024;
  const h = asset.height ?? 768;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          fontSize: 13,
        }}
      >
        <span style={{ opacity: 0.8 }}>{asset.original_name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ opacity: 0.6 }}>
          {saveMutation.isPending
            ? "Saving…"
            : dirtyCount > 0
              ? `${dirtyCount} unsaved`
              : "Saved"}
        </span>
        <button onClick={saveNow}>Save now</button>
      </header>
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Toolbar />
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 12, overflow: "auto" }}>
          <AnnotationCanvas width={w} height={h} imageUrl={url} frameId={frameId} />
        </div>
        <aside
          style={{
            width: 280,
            borderLeft: "1px solid rgba(255,255,255,0.1)",
            padding: 12,
            display: "grid",
            gap: 16,
            overflow: "auto",
          }}
        >
          <ClassesPanel classes={classesQ.data ?? []} />
          <ObjectsPanel frameId={frameId} />
        </aside>
      </div>
      {asset.kind === "video" && (asset.frames ?? 0) > 1 && (
        <FrameTimeline
          totalFrames={asset.frames}
          currentIdx={currentFrameIdx}
          onChange={setCurrentFrameIdx}
        />
      )}
      <CommandPalette classes={classesQ.data ?? []} onSaveNow={saveNow} />
    </div>
  );
}

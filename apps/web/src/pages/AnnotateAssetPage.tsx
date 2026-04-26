import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Loader2 } from "lucide-react";

import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { CommandPalette } from "@/components/annotation/CommandPalette";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { TopBar } from "@/components/nav/TopBar";
import { LeftNav } from "@/components/nav/LeftNav";
import { BottomBar } from "@/components/nav/BottomBar";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import { classesApi } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { useAnnotations } from "@/state/annotations";
import { cn } from "@/lib/cn";

interface Props {
  projectId: string;
  taskId: string;
  assetId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 2000;

export function AnnotateAssetPage({ projectId, taskId, assetId }: Props) {
  const qc = useQueryClient();
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);
  const [zoomPct, setZoomPct] = useState(100);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  const assetQ = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => assetsApi.get(assetId),
  });
  const classesQ = useQuery({
    queryKey: ["classes", projectId],
    queryFn: () => classesApi.listForProject(projectId),
  });

  // For images, the single Frame for the asset.
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

  // Publish class colors to the canvas via a window event so the canvas can
  // render shapes in the correct color without a context dependency.
  useEffect(() => {
    if (!classesQ.data) return;
    const map: Record<string, string> = {};
    for (const c of classesQ.data) map[c.id] = c.color;
    window.dispatchEvent(new CustomEvent("carve:class-colors", { detail: map }));
  }, [classesQ.data]);

  // Reactive dirty count from store
  const byId = useAnnotations((s) => s.byId);
  const pendingDeletes = useAnnotations((s) => s.pendingDeletes);
  const dirtyCount =
    Object.values(byId).filter((d) => d.dirty).length + pendingDeletes.length;

  const saveMutation = useMutation({
    mutationFn: (payload: BatchPayload) => annotationsApi.batch(taskId, payload),
    onSuccess: (res, variables) => {
      const created = res.created;
      const sentCreates = variables.create;
      const sentTemp = Object.values(useAnnotations.getState().byId)
        .filter((a) => a.serverId === null && a.dirty)
        .slice(0, sentCreates.length);
      sentTemp.forEach((draft, i) => {
        const server = created[i];
        if (server) useAnnotations.getState().markPersisted(draft.tempId, server.id);
      });
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

  function buildPayload(): BatchPayload {
    const drafts = Object.values(useAnnotations.getState().byId);
    const create = drafts
      .filter((d) => d.serverId === null && d.dirty)
      .map((d) => ({
        frame_id: d.frameId,
        class_id: d.classId,
        kind: d.kind,
        geometry: d.geometry as unknown as Record<string, unknown>,
        track_id: d.trackId ?? null,
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

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  // Debounced autosave on store changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = useAnnotations.subscribe((s, prev) => {
      if (s.byId === prev.byId && s.pendingDeletes === prev.pendingDeletes) return;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        saveNowRef.current();
      }, AUTOSAVE_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  // Manual Cmd+S
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveNowRef.current();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const crumbs = useMemo(() => {
    const c: { label: string; to?: string }[] = [{ label: "Projects", to: "/projects" }];
    if (projectQ.data) c.push({ label: projectQ.data.name, to: `/projects/${projectId}` });
    if (assetQ.data) c.push({ label: assetQ.data.asset.original_name });
    return c;
  }, [projectQ.data, assetQ.data, projectId]);

  if (assetQ.isLoading || classesQ.isLoading) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex items-center gap-2 text-[color:var(--text-tertiary)] text-[13px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }
  if (assetQ.error || !assetQ.data) {
    return (
      <div className="grid h-screen place-items-center">
        <p className="text-[color:var(--danger)] text-[14px]">Failed to load asset.</p>
      </div>
    );
  }

  const asset = assetQ.data.asset;
  const url = assetQ.data.url;
  const w = asset.width ?? 1024;
  const h = asset.height ?? 768;
  const isVideo = asset.kind === "video" && (asset.frames ?? 0) > 1;
  const hasError = saveMutation.isError;

  return (
    <TooltipProvider delayDuration={250}>
    <div className="flex h-screen flex-col bg-[var(--bg-app)] overflow-hidden">
      <TopBar crumbs={crumbs} />

      <div className="flex flex-1 min-h-0">
        <LeftNav />

        <div className="flex flex-1 min-w-0 flex-col">
          <EditorToolbar
            onSave={saveNow}
            isSaving={saveMutation.isPending}
            hasError={hasError}
            dirtyCount={dirtyCount}
            onToggleVisibility={() => setAnnotationsVisible((v) => !v)}
            visibilityOn={annotationsVisible}
          />

          <div className="flex flex-1 min-h-0">
            <main
              className={cn(
                "relative flex-1 min-w-0 bg-[var(--bg-canvas)]",
                !annotationsVisible && "[&_.canvas-checker_*]:hidden",
              )}
            >
              <AnnotationCanvas
                width={w}
                height={h}
                imageUrl={url}
                frameId={frameId}
                assetId={assetId}
                onZoomChange={setZoomPct}
              />
            </main>

            <aside
              role="complementary"
              aria-label="Classes"
              className="w-[220px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-app)] flex flex-col"
            >
              <Tabs.Root defaultValue="classes" className="flex flex-col h-full">
                <Tabs.List
                  aria-label="Side panel"
                  className="flex shrink-0 border-b border-[var(--border-subtle)] px-2 pt-2 gap-1"
                >
                  <Tabs.Trigger
                    value="classes"
                    className={cn(
                      "px-2.5 py-1.5 text-[12px] tracking-tight rounded-t-[var(--radius-sm)]",
                      "text-[color:var(--text-tertiary)] border-b-2 border-transparent",
                      "hover:text-[color:var(--text-primary)]",
                      "data-[state=active]:text-[color:var(--text-primary)] data-[state=active]:border-[var(--accent)]",
                      "transition-colors",
                    )}
                  >
                    Classes
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="objects"
                    className={cn(
                      "px-2.5 py-1.5 text-[12px] tracking-tight rounded-t-[var(--radius-sm)]",
                      "text-[color:var(--text-tertiary)] border-b-2 border-transparent",
                      "hover:text-[color:var(--text-primary)]",
                      "data-[state=active]:text-[color:var(--text-primary)] data-[state=active]:border-[var(--accent)]",
                      "transition-colors",
                    )}
                  >
                    Objects
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content
                  value="classes"
                  className="flex-1 min-h-0 overflow-hidden focus-visible:outline-none"
                >
                  <ClassesPanel classes={classesQ.data ?? []} />
                </Tabs.Content>
                <Tabs.Content
                  value="objects"
                  className="flex-1 overflow-y-auto p-3 focus-visible:outline-none"
                >
                  <ObjectsPanel frameId={frameId} />
                </Tabs.Content>
              </Tabs.Root>
            </aside>
          </div>

          {isVideo && (
            <FrameTimeline
              totalFrames={asset.frames}
              currentIdx={currentFrameIdx}
              onChange={setCurrentFrameIdx}
            />
          )}

          <BottomBar
            thumbnailUrl={url}
            filename={asset.original_name}
            width={w}
            height={h}
            zoomPct={zoomPct}
          />
        </div>
      </div>

      <CommandPalette classes={classesQ.data ?? []} onSaveNow={saveNow} />
    </div>
    </TooltipProvider>
  );
}

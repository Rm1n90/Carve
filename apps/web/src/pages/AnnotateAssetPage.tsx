import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { CommandPalette } from "@/components/annotation/CommandPalette";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { KeyboardCheatSheet } from "@/components/annotation/KeyboardCheatSheet";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";
import { TopBar } from "@/components/nav/TopBar";
import { LeftNav } from "@/components/nav/LeftNav";
import { BottomBar } from "@/components/nav/BottomBar";
import { IconButton } from "@/components/ui/IconButton";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import { classesApi } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { useAnnotations } from "@/state/annotations";
import { useTool } from "@/state/tool";
import { cn } from "@/lib/cn";

interface Props {
  projectId: string;
  taskId: string;
  assetId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 2000;

function ThumbnailStripGate({
  taskId,
  projectId,
  activeAssetId,
}: {
  taskId: string;
  projectId: string;
  activeAssetId: string;
}) {
  const enabled = useTool((s) => s.visibility.thumbnails);
  if (!enabled) return null;
  return (
    <AssetThumbnailStrip
      taskId={taskId}
      projectId={projectId}
      activeAssetId={activeAssetId}
    />
  );
}

export function AnnotateAssetPage({ projectId, taskId, assetId }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
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

  // List of all assets in this task — drives ArrowLeft/ArrowRight navigation
  // and the prev/next IconButtons in the toolbar. The same query is consumed
  // by AssetThumbnailStrip below; React Query dedupes by key.
  const taskAssetsQ = useQuery({
    queryKey: ["task-assets", taskId],
    queryFn: () => assetsApi.listForTask(taskId),
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

  // Browser tab title — show the current asset name so multi-tab workflows
  // are tractable. Restore the default title on unmount. Audit bug R.
  useEffect(() => {
    const name = assetQ.data?.asset?.original_name;
    if (!name) return;
    const previous = document.title;
    document.title = `${name} — Carve`;
    return () => {
      document.title = previous;
    };
  }, [assetQ.data?.asset?.original_name]);

  // Class colors flow into the canvas as a prop (formerly a CustomEvent —
  // see audit bug H for the timing race that motivated this change).
  const classColorMap = useMemo<Record<string, string>>(() => {
    if (!classesQ.data) return {};
    const m: Record<string, string> = {};
    for (const c of classesQ.data) m[c.id] = c.color;
    return m;
  }, [classesQ.data]);

  // Class names — used by the canvas's floating bbox label tags when the
  // `labels` visibility flag is on. See audit bug O.
  const classNameMap = useMemo<Record<string, string>>(() => {
    if (!classesQ.data) return {};
    const m: Record<string, string> = {};
    for (const c of classesQ.data) m[c.id] = c.name;
    return m;
  }, [classesQ.data]);

  // Prev/next asset navigation — wraps both the ArrowLeft/ArrowRight handler
  // below and the IconButtons in the editor top bar.
  const taskAssets = taskAssetsQ.data ?? [];
  const currentAssetIdx = taskAssets.findIndex((a) => a.id === assetId);
  const prevAsset = currentAssetIdx > 0 ? taskAssets[currentAssetIdx - 1] : null;
  const nextAsset =
    currentAssetIdx >= 0 && currentAssetIdx < taskAssets.length - 1
      ? taskAssets[currentAssetIdx + 1]
      : null;
  const navAssetRef = useRef<{ prev: typeof prevAsset; next: typeof nextAsset }>({
    prev: prevAsset,
    next: nextAsset,
  });
  navAssetRef.current = { prev: prevAsset, next: nextAsset };

  function goToAsset(targetId: string) {
    void navigate({
      to: "/projects/$projectId/tasks/$taskId/assets/$assetId",
      params: { projectId, taskId, assetId: targetId },
    });
  }

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
      // Prefer temp_id correlation (audit bug M). Falls back to the legacy
      // order-based path if the server didn't echo created_temp_ids — for
      // safety during rolling deploys.
      if (res.created_temp_ids && res.created_temp_ids.length === created.length) {
        for (let i = 0; i < created.length; i++) {
          const tempId = res.created_temp_ids[i];
          if (tempId) {
            useAnnotations.getState().markPersisted(tempId, created[i].id);
          }
        }
      } else {
        const sentTemp = Object.values(useAnnotations.getState().byId)
          .filter((a) => a.serverId === null && a.dirty)
          .slice(0, sentCreates.length);
        sentTemp.forEach((draft, i) => {
          const server = created[i];
          if (server) useAnnotations.getState().markPersisted(draft.tempId, server.id);
        });
      }
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
        // Echoed back in res.created_temp_ids so we can correlate without
        // relying on iteration order. Audit bug M.
        temp_id: d.tempId,
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

  // Manual Cmd+S, Cmd+Z, Cmd+Shift+Z, Cmd+A, Backspace, z-order shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      const k = e.key.toLowerCase();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && k === "s") {
        e.preventDefault();
        saveNowRef.current();
        return;
      }
      if (meta && k === "z" && !e.shiftKey) {
        e.preventDefault();
        useAnnotations.getState().undo();
        return;
      }
      if (meta && k === "z" && e.shiftKey) {
        e.preventDefault();
        useAnnotations.getState().redo();
        return;
      }
      if (meta && k === "a") {
        e.preventDefault();
        useAnnotations.getState().selectAll(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        const ids = useAnnotations.getState().selectedIds;
        if (ids.length > 0) {
          e.preventDefault();
          for (const id of ids) {
            useAnnotations.getState().remove(id);
          }
        }
        return;
      }
      // Z-order: Cmd+Shift+] / Cmd+] / Cmd+[ / Cmd+Shift+[
      if (meta && (e.key === "]" || e.key === "[")) {
        const sel = useAnnotations.getState().selectedId;
        if (!sel) return;
        e.preventDefault();
        if (e.key === "]" && e.shiftKey) {
          useAnnotations.getState().bringToFront(sel);
        } else if (e.key === "]") {
          useAnnotations.getState().bringForward(sel);
        } else if (e.key === "[" && e.shiftKey) {
          useAnnotations.getState().sendToBack(sel);
        } else if (e.key === "[") {
          useAnnotations.getState().sendBackward(sel);
        }
        return;
      }
      // Prev/next asset navigation. Stop at boundaries (no wrap).
      if (!meta && e.key === "ArrowLeft") {
        const target = navAssetRef.current.prev;
        if (target) {
          e.preventDefault();
          goToAsset(target.id);
        }
        return;
      }
      if (!meta && e.key === "ArrowRight") {
        const target = navAssetRef.current.next;
        if (target) {
          e.preventDefault();
          goToAsset(target.id);
        }
        return;
      }
      // Esc clears selection
      if (e.key === "Escape") {
        useAnnotations.getState().clearSelection();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId]);

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
      <TopBar
        crumbs={crumbs}
        rightAction={
          taskAssets.length > 1 ? (
            <div
              data-testid="asset-nav-buttons"
              className="flex items-center gap-1 mr-2"
            >
              <IconButton
                aria-label="Previous asset"
                size="sm"
                disabled={!prevAsset}
                onClick={() => prevAsset && goToAsset(prevAsset.id)}
              >
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <span className="font-mono text-[11px] tabular-nums text-[color:var(--text-tertiary)] px-1">
                {currentAssetIdx >= 0 ? currentAssetIdx + 1 : "?"}
                <span className="opacity-60"> / {taskAssets.length}</span>
              </span>
              <IconButton
                aria-label="Next asset"
                size="sm"
                disabled={!nextAsset}
                onClick={() => nextAsset && goToAsset(nextAsset.id)}
              >
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </div>
          ) : null
        }
      />

      <div className="flex flex-1 min-h-0">
        <LeftNav />

        <div className="flex flex-1 min-w-0 flex-col">
          <EditorToolbar
            projectId={projectId}
            assetId={assetId}
            onSave={saveNow}
            isSaving={saveMutation.isPending}
            hasError={hasError}
            dirtyCount={dirtyCount}
            zoomPct={zoomPct}
            onZoomIn={() => setZoomPct((z) => Math.min(800, z + 25))}
            onZoomOut={() => setZoomPct((z) => Math.max(10, z - 25))}
            onZoomTo={(p) => {
              if (p === 0) {
                window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
              } else {
                setZoomPct(p);
              }
            }}
            onFitToScreen={() => {
              window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
            }}
            onUndo={() => useAnnotations.getState().undo()}
            onRedo={() => useAnnotations.getState().redo()}
            onAfterYoloPredict={() => {
              qc.invalidateQueries({ queryKey: ["annotations", taskId] });
            }}
            onToggleVisibility={() => setAnnotationsVisible((v) => !v)}
            visibilityOn={annotationsVisible}
          />

          <ThumbnailStripGate
            taskId={taskId}
            projectId={projectId}
            activeAssetId={assetId}
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
                classColorMap={classColorMap}
                classNameMap={classNameMap}
              />
              <div className="absolute top-2 right-2 z-20">
                <KeyboardCheatSheet />
              </div>
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

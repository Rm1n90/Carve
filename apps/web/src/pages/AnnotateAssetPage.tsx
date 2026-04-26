import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  Save,
  Keyboard,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

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
import { Tooltip } from "@/components/ui/Tooltip";
import { Kbd } from "@/components/ui/Kbd";
import { cn } from "@/lib/cn";

interface Props {
  projectId: string;
  taskId: string;
  assetId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 2000;

function SaveIndicator({
  isSaving,
  hasError,
  dirtyCount,
}: {
  isSaving: boolean;
  hasError: boolean;
  dirtyCount: number;
}) {
  if (isSaving) {
    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--border-accent)] bg-[var(--accent-bg)] text-[11px] text-[var(--accent)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (hasError) {
    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[oklch(0.70_0.20_25_/_0.40)] bg-[oklch(0.70_0.20_25_/_0.10)] text-[11px] text-[var(--danger)]">
        <AlertCircle className="h-3 w-3" />
        Save failed
      </span>
    );
  }
  if (dirtyCount > 0) {
    return (
      <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[oklch(0.84_0.17_75_/_0.40)] bg-[oklch(0.84_0.17_75_/_0.10)] text-[11px] text-[var(--warning)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" aria-hidden />
        {dirtyCount} unsaved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[oklch(0.78_0.16_145_/_0.35)] bg-[oklch(0.78_0.16_145_/_0.08)] text-[11px] text-[var(--success)]">
      <CheckCircle2 className="h-3 w-3" />
      Saved
    </span>
  );
}

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

  // Keep a ref to the latest saveNow so subscribe/keydown effects always call
  // the freshest closure (saveMutation is recreated each render).
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

  if (assetQ.isLoading || classesQ.isLoading) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="flex items-center gap-3 text-tertiary text-[13px]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }
  if (assetQ.error || !assetQ.data) {
    return (
      <div className="grid h-screen place-items-center">
        <p className="text-[var(--danger)] text-[14px]">Failed to load asset.</p>
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
      <div className="flex h-screen flex-col bg-[var(--bg-base)] overflow-hidden">
        {/* ---- TOP CHROME ---- */}
        <header
          className={cn(
            "flex h-11 shrink-0 items-center gap-3 px-4",
            "border-b border-[var(--border-subtle)]",
            "bg-[var(--bg-glass-strong)] backdrop-blur-xl",
          )}
        >
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[12px] min-w-0">
            <span className="text-tertiary tracking-tight font-mono-data text-[10px] uppercase">
              Annotate
            </span>
            <span className="text-tertiary mx-1">/</span>
            <span className="text-secondary tracking-tight truncate" title={asset.original_name}>
              {asset.original_name}
            </span>
          </nav>

          <div className="flex-1" />

          <SaveIndicator
            isSaving={saveMutation.isPending}
            hasError={hasError}
            dirtyCount={dirtyCount}
          />

          {isVideo && (
            <span className="font-mono-data text-[11px] text-tertiary tracking-wide">
              {currentFrameIdx + 1}/{asset.frames}
            </span>
          )}

          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Save now <Kbd>⌘ S</Kbd>
              </span>
            }
          >
            <button
              type="button"
              onClick={saveNow}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3",
                "rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
                "bg-[var(--bg-surface)] text-secondary text-[12px]",
                "hover:border-[var(--border-strong)] hover:text-primary",
                "transition-colors",
              )}
              aria-label="Save now"
            >
              <Save className="h-3.5 w-3.5" />
              Save now
            </button>
          </Tooltip>

          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Command palette <Kbd>⌘ K</Kbd>
              </span>
            }
          >
            <button
              type="button"
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-tertiary hover:bg-[var(--bg-surface)] hover:text-primary transition-colors"
              aria-label="Open command palette"
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </Tooltip>
        </header>

        {/* ---- THREE-PANEL BODY ---- */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* LEFT TOOL DOCK */}
          <Toolbar />

          {/* CENTER CANVAS */}
          <main
            className={cn(
              "relative flex-1 grid place-items-center min-w-0 overflow-auto",
              "bg-[var(--bg-sunken)] canvas-vignette",
            )}
          >
            <div className="relative">
              <AnnotationCanvas
                width={w}
                height={h}
                imageUrl={url}
                frameId={frameId}
                assetId={assetId}
              />
            </div>
          </main>

          {/* RIGHT PANEL */}
          <aside
            className={cn(
              "flex w-[320px] shrink-0 flex-col",
              "border-l border-[var(--border-subtle)]",
              "bg-[var(--bg-glass-strong)] backdrop-blur-xl",
            )}
          >
            <Tabs.Root defaultValue="classes" className="flex flex-col h-full">
              <Tabs.List
                aria-label="Side panel"
                className="flex shrink-0 border-b border-[var(--border-subtle)] px-3 pt-3 gap-1"
              >
                <Tabs.Trigger
                  value="classes"
                  className={cn(
                    "px-3 py-2 text-[12px] tracking-tight rounded-t-[var(--radius-sm)]",
                    "text-tertiary border-b-2 border-transparent",
                    "hover:text-primary",
                    "data-[state=active]:text-primary data-[state=active]:border-[var(--accent)]",
                    "transition-colors",
                  )}
                >
                  Classes
                </Tabs.Trigger>
                <Tabs.Trigger
                  value="objects"
                  className={cn(
                    "px-3 py-2 text-[12px] tracking-tight rounded-t-[var(--radius-sm)]",
                    "text-tertiary border-b-2 border-transparent",
                    "hover:text-primary",
                    "data-[state=active]:text-primary data-[state=active]:border-[var(--accent)]",
                    "transition-colors",
                  )}
                >
                  Objects
                </Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content
                value="classes"
                className="flex-1 overflow-y-auto p-3 focus-visible:outline-none"
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

        {/* ---- VIDEO TIMELINE ---- */}
        {isVideo && (
          <FrameTimeline
            totalFrames={asset.frames}
            currentIdx={currentFrameIdx}
            onChange={setCurrentFrameIdx}
          />
        )}

        <CommandPalette classes={classesQ.data ?? []} onSaveNow={saveNow} />
      </div>
    </TooltipProvider>
  );
}

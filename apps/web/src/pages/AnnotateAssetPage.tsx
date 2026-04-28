import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Tabs from "@radix-ui/react-tabs";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { AnnotationCanvas, type ImageLoadStatus } from "@/components/annotation/AnnotationCanvas";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { CommandPalette } from "@/components/annotation/CommandPalette";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { InfoDialog } from "@/components/annotation/InfoDialog";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { AppearancePanel } from "@/components/annotation/AppearancePanel";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { KeyboardCheatSheet } from "@/components/annotation/KeyboardCheatSheet";
import { SelectionCountBadge } from "@/components/annotation/SelectionCountBadge";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";
import { SamUnavailableBanner } from "@/components/annotation/SamUnavailableBanner";
import { TopBar } from "@/components/nav/TopBar";
import { LeftNav } from "@/components/nav/LeftNav";
import { BottomBar } from "@/components/nav/BottomBar";
import { IconButton } from "@/components/ui/IconButton";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import { classesApi, type ClassIn } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { useAnnotations } from "@/state/annotations";
import { useAuth } from "@/auth/store";
import { useTool } from "@/state/tool";
import { useEditorSettings } from "@/state/editorSettings";
import { cn } from "@/lib/cn";

interface Props {
  projectId: string;
  taskId: string;
  assetId: string;
}

// Default debounce when no user-set value is present. The actual value
// is read live from `useEditorSettings.autoSaveIntervalSeconds` (see the
// effect below) so changes from the settings dialog take effect on the
// next save event.
const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 1500;

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
  // When the user enables Settings → Player → "Reset zoom on frame change",
  // navigating between frames fits the canvas back to 100%. Without this
  // a zoomed-in view would silently follow the user across frames, which
  // is rarely what they want. (Settings.resetZoomOnFrameChange wiring.)
  useEffect(() => {
    if (useEditorSettings.getState().resetZoomOnFrameChange) {
      window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
    }
  }, [currentFrameIdx]);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  // v2.6 — Info dialog (CVAT-style task overview + per-class stats).
  // Aggregates from the in-memory annotations store; no extra API calls.
  const [infoOpen, setInfoOpen] = useState(false);
  // Image load lifecycle. Phase A core 1 — without this, image load failures
  // were invisible and the user just saw an empty canvas.
  const [imageStatus, setImageStatus] = useState<ImageLoadStatus>("loading");
  const [imageError, setImageError] = useState<string | null>(null);
  // Bumping this triggers AnnotationCanvas to retry the image load.
  const [imageReloadKey, setImageReloadKey] = useState(0);
  const handleImageStatusChange = useCallback(
    (status: ImageLoadStatus, errorMessage?: string) => {
      setImageStatus(status);
      setImageError(status === "error" ? (errorMessage ?? "unknown error") : null);
    },
    [],
  );
  const handleImageRetry = useCallback(() => {
    setImageReloadKey((k) => k + 1);
  }, []);

  const projectQ = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId),
  });
  // `placeholderData: prev => prev` keeps the previous asset's data on
  // screen while the next asset's query is in flight. Without it, every
  // navigation flashes the entire editor through a "Loading…" page while
  // the new asset is fetched. v2.5 perf fix.
  const assetQ = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => assetsApi.get(assetId),
    placeholderData: (prev) => prev,
    staleTime: 5 * 60 * 1000,
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

  // For images, the single Frame for the asset. v2.5.1 — read the real
  // frame_id from the asset detail response. Previously this was hardcoded
  // to null, which meant every annotation saved with frame_id=null and
  // the per-task list query returned ALL annotations across the task,
  // making bboxes drawn on one image appear on every other image.
  const frameId: string | null = assetQ.data?.frame_id ?? null;
  // Live ref that the (memoised) keydown handler reads at call-time.
  // Without this Cmd+A captures whatever ``frameId`` was on the first
  // render — which is ``null`` until ``assetQ`` resolves, so video
  // assets see selectAll(null) and the user gets nothing selected.
  // v2.7 wave 2 item 4.
  const frameIdRef = useRef<string | null>(frameId);
  frameIdRef.current = frameId;

  const annotationsQ = useQuery({
    queryKey: ["annotations", taskId, frameId],
    queryFn: async () => annotationsApi.listForTask(taskId, frameId ?? undefined),
    // Note: the editor canvas doesn't mount until ``assetQ.data`` is
    // available (see the early-return loading screen below), so even if
    // this query briefly fires with frameId=null on first render, the
    // user never sees the resulting (unscoped) annotations because the
    // refetch under the correct frame_id has already replaced them by
    // the time the canvas paints.
  });

  // Seed the store on first load + when annotations change identity.
  // React Query keys include the frameId, so an asset switch produces a
  // new query result (and thus a new array reference) on resolution —
  // depending on ``annotationsQ.data`` alone is sufficient to reseed
  // when the user navigates to a different asset.
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

  // Full ClassRow lookup keyed by id — passed to ObjectsPanel so the
  // CVAT-style filter evaluator can resolve `label` rules. v2.6.
  const classByIdMap = useMemo(() => {
    if (!classesQ.data) return {};
    const m: Record<string, (typeof classesQ.data)[number]> = {};
    for (const c of classesQ.data) m[c.id] = c;
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

  // Prefetch prev/next asset metadata + warm the browser image cache for
  // their thumbnails. When the user hits ArrowLeft/Right the new asset's
  // query is already populated, so navigation is near-instant. v2.5 perf
  // fix.
  useEffect(() => {
    const targets: { id: string; thumb: string | null }[] = [];
    if (prevAsset) targets.push({ id: prevAsset.id, thumb: prevAsset.thumbnail_url });
    if (nextAsset) targets.push({ id: nextAsset.id, thumb: nextAsset.thumbnail_url });
    for (const t of targets) {
      qc.prefetchQuery({
        queryKey: ["asset", t.id],
        queryFn: () => assetsApi.get(t.id),
        staleTime: 5 * 60 * 1000,
      });
      if (t.thumb) {
        // Warm the browser image cache so the thumbnail strip + future
        // <img> renders are an immediate cache hit. The Image() instance
        // is GC'd as soon as the browser caches the bytes.
        const img = new Image();
        img.src = t.thumb;
      }
    }
    // We deliberately depend on the asset ids only, not the full Asset
    // objects, so prefetch fires once per neighbour change.
  }, [prevAsset?.id, nextAsset?.id, qc]);

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

  // Inline class management mutations — exposed via ClassesPanel callbacks
  // so the user can add/edit/delete classes without leaving the editor.
  // Phase A core 4.
  const classCreate = useMutation({
    mutationFn: (input: ClassIn) => classesApi.create(projectId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });
  const classUpdate = useMutation({
    mutationFn: ({ cid, patch }: { cid: string; patch: Partial<ClassIn> }) =>
      classesApi.update(projectId, cid, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });
  const classRemove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classes", projectId] }),
  });

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

  // Debounced autosave on store changes. Debounce duration is read from
  // `useEditorSettings.autoSaveIntervalSeconds` at the moment the timer
  // is scheduled, so changes from the settings dialog take effect on the
  // next user edit without a remount.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = useAnnotations.subscribe((s, prev) => {
      if (s.byId === prev.byId && s.pendingDeletes === prev.pendingDeletes) return;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      const seconds = useEditorSettings.getState().autoSaveIntervalSeconds;
      const ms = Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds * 1000)
        : DEFAULT_AUTOSAVE_DEBOUNCE_MS;
      debounceRef.current = setTimeout(() => {
        saveNowRef.current();
      }, ms);
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
        // Read the live frameId so Cmd+A picks up the current asset's
        // frame, not the value captured when this useEffect first ran
        // (frameId can flip from null -> non-null when assetQ resolves;
        // the useEffect deps are [projectId, taskId] for stability so
        // we use a ref instead). v2.7 wave 2 item 4.
        useAnnotations.getState().selectAll(frameIdRef.current);
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

  // Only show the full-page loading screen on initial mount (no data yet).
  // During asset navigation, `assetQ.data` still holds the previous asset
  // thanks to `placeholderData`, so we render the full editor and let the
  // canvas + status badge surface the in-flight state. v2.5 perf fix.
  if (!assetQ.data || !classesQ.data) {
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
          <div className="flex items-center gap-2">
            <ImageStatusBadge status={imageStatus} />
            {taskAssets.length > 1 ? (
              <AssetNavControls
                taskAssets={taskAssets}
                currentAssetIdx={currentAssetIdx}
                prevAsset={prevAsset}
                nextAsset={nextAsset}
                onGoTo={goToAsset}
              />
            ) : null}
          </div>
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
            onZoomIn={() => {
              window.dispatchEvent(new CustomEvent("carve:zoom-in"));
            }}
            onZoomOut={() => {
              window.dispatchEvent(new CustomEvent("carve:zoom-out"));
            }}
            onZoomTo={(p) => {
              if (p === 0) {
                window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
              } else {
                window.dispatchEvent(
                  new CustomEvent("carve:zoom-to", { detail: { pct: p } }),
                );
              }
            }}
            onZoomActual={() => {
              window.dispatchEvent(new CustomEvent("carve:zoom-actual"));
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

          <SamUnavailableBanner />

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
                onImageStatusChange={handleImageStatusChange}
                reloadKey={imageReloadKey}
                classColorMap={classColorMap}
                classNameMap={classNameMap}
                classes={classesQ.data ?? []}
              />
              <SelectionCountBadge />
              {imageStatus === "error" && (
                <div
                  data-testid="canvas-image-error-overlay"
                  className={cn(
                    "absolute inset-0 z-30 flex items-center justify-center",
                    "bg-[rgba(15,23,42,0.32)] backdrop-blur-[2px]",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[420px] rounded-[var(--radius-md)] border border-[var(--border-strong)]",
                      "bg-[var(--bg-elev)] shadow-[var(--shadow-elev-2)] p-4 grid gap-2.5",
                    )}
                  >
                    <div className="flex items-center gap-2 text-[color:var(--danger)]">
                      <AlertCircle className="h-4 w-4" />
                      <span className="text-[13px] font-medium tracking-tight">
                        Failed to load image
                      </span>
                    </div>
                    <p className="text-[12px] text-[color:var(--text-secondary)] leading-snug">
                      {imageError ?? "The image could not be fetched."}
                    </p>
                    <button
                      type="button"
                      onClick={handleImageRetry}
                      data-testid="canvas-image-retry"
                      className={cn(
                        "inline-flex w-fit items-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)]",
                        "bg-[var(--accent)] text-[color:var(--accent-fg)] text-[12.5px] font-medium",
                        "hover:bg-[var(--accent-hover)] transition-colors",
                      )}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry
                    </button>
                  </div>
                </div>
              )}
              <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Show task info"
                  data-testid="info-dialog-trigger"
                  title="Task info"
                  onClick={() => setInfoOpen(true)}
                  className={cn(
                    "grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]",
                    "text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
                  )}
                >
                  <Info className="h-[18px] w-[18px]" />
                </button>
                <KeyboardCheatSheet />
              </div>
            </main>

            <aside
              role="complementary"
              aria-label="Classes"
              className="w-[220px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-app)] flex flex-col"
            >
              <Tabs.Root defaultValue="classes" className="flex-1 min-h-0 flex flex-col">
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
                  <ClassesPanel
                    classes={classesQ.data ?? []}
                    onCreateClass={(name, color) => {
                      const list = classesQ.data ?? [];
                      const nextIdx = list.reduce(
                        (m, c) => Math.max(m, c.idx + 1),
                        0,
                      );
                      classCreate.mutate({ idx: nextIdx, name, color });
                    }}
                    onUpdateColor={(cid, color) =>
                      classUpdate.mutate({ cid, patch: { color } })
                    }
                    onEditClass={(cid) => {
                      const cls = (classesQ.data ?? []).find((c) => c.id === cid);
                      if (!cls) return;
                      const next = window.prompt("Rename class", cls.name);
                      if (next && next.trim() && next !== cls.name) {
                        classUpdate.mutate({ cid, patch: { name: next.trim() } });
                      }
                    }}
                    onDeleteClass={(cid) => classRemove.mutate(cid)}
                  />
                </Tabs.Content>
                <Tabs.Content
                  value="objects"
                  className="flex-1 overflow-y-auto p-3 focus-visible:outline-none"
                >
                  <ObjectsPanel frameId={frameId} classes={classByIdMap} />
                </Tabs.Content>
              </Tabs.Root>
              <AppearancePanel />
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

      <InfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        asset={assetQ.data}
        totalAssets={taskAssets.length}
        classes={classesQ.data ?? []}
        assigneeEmail={useAuth.getState().user?.email ?? null}
      />
    </div>
    </TooltipProvider>
  );
}

/**
 * Tiny status pill rendered in the editor top bar showing the current
 * image's load lifecycle. Phase A core 1. Three discrete states only:
 * loading (amber), loaded (green), error (red). Color follows the existing
 * design tokens — no new colors introduced.
 */
function ImageStatusBadge({ status }: { status: ImageLoadStatus }) {
  const map: Record<ImageLoadStatus, { dot: string; label: string; fg: string; bg: string }> = {
    loading: {
      dot: "bg-[#D97706] animate-pulse",
      label: "Loading…",
      fg: "text-[#92400E]",
      bg: "bg-[#FEF3C7]",
    },
    loaded: {
      dot: "bg-[var(--success)]",
      label: "Image",
      fg: "text-[color:var(--text-secondary)]",
      bg: "bg-[var(--bg-subtle)]",
    },
    error: {
      dot: "bg-[var(--danger)]",
      label: "Image error",
      fg: "text-[color:var(--danger)]",
      bg: "bg-[var(--danger-bg)]",
    },
  };
  const { dot, label, fg, bg } = map[status];
  return (
    <span
      data-testid="image-status-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 h-6 rounded-full",
        "text-[11px] font-medium tracking-tight",
        bg,
        fg,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

/**
 * Prev/Next asset controls with a clickable "N / total" indicator that
 * opens a popover for jumping to a specific image number. Phase A core 6.
 */
function AssetNavControls({
  taskAssets,
  currentAssetIdx,
  prevAsset,
  nextAsset,
  onGoTo,
}: {
  taskAssets: { id: string }[];
  currentAssetIdx: number;
  prevAsset: { id: string } | null;
  nextAsset: { id: string } | null;
  onGoTo: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    const n = parseInt(draft, 10);
    if (Number.isInteger(n) && n >= 1 && n <= taskAssets.length) {
      const target = taskAssets[n - 1];
      if (target) onGoTo(target.id);
    }
    setEditing(false);
    setDraft("");
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  return (
    <div data-testid="asset-nav-buttons" className="flex items-center gap-1 mr-2">
      <IconButton
        aria-label="Previous asset"
        size="sm"
        disabled={!prevAsset}
        onClick={() => prevAsset && onGoTo(prevAsset.id)}
      >
        <ChevronLeft className="h-4 w-4" />
      </IconButton>
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={taskAssets.length}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setEditing(false);
              setDraft("");
            }
          }}
          aria-label="Go to image number"
          data-testid="asset-nav-input"
          className={cn(
            "w-12 h-6 px-1 text-[11px] tabular-nums text-center font-mono",
            "rounded-[var(--radius-xs)] border border-[var(--accent)]",
            "bg-[var(--bg-elev)] focus:outline-none",
          )}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setDraft(String(currentAssetIdx >= 0 ? currentAssetIdx + 1 : 1));
          }}
          aria-label="Go to image number"
          data-testid="asset-nav-counter"
          className={cn(
            "font-mono text-[11px] tabular-nums px-1 h-6 rounded-[var(--radius-xs)]",
            "text-[color:var(--text-tertiary)] hover:bg-[var(--bg-hover)]",
            "hover:text-[color:var(--text-primary)] transition-colors",
          )}
        >
          {currentAssetIdx >= 0 ? currentAssetIdx + 1 : "?"}
          <span className="opacity-60"> / {taskAssets.length}</span>
        </button>
      )}
      <IconButton
        aria-label="Next asset"
        size="sm"
        disabled={!nextAsset}
        onClick={() => nextAsset && onGoTo(nextAsset.id)}
      >
        <ChevronRight className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

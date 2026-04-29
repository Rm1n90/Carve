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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import { assetsApi } from "@/api/assets";
import { classesApi, type ClassIn } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { useAnnotations } from "@/state/annotations";
import { useAuth } from "@/auth/store";
import { useTool } from "@/state/tool";
import { useEditorSettings } from "@/state/editorSettings";
import { useResizableRightPanel } from "@/hooks/useResizableRightPanel";
import { showToast } from "@/lib/toast";
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
  // v2.9 P2 E5 — subscribe to the setting so toggling it takes effect
  // without requiring a frame change.
  const resetZoomOnFrameChange = useEditorSettings((s) => s.resetZoomOnFrameChange);
  useEffect(() => {
    if (resetZoomOnFrameChange) {
      window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
    }
  }, [currentFrameIdx, resetZoomOnFrameChange]);
  // v2.9 P0-3: was `useState(true)` paired with dead `visibilityOn` /
  // `onToggleVisibility` props on EditorToolbar. The visibility menu in
  // the toolbar already drives `useTool.visibility.annotations`, so we
  // read that here instead of holding a parallel flag.
  const annotationsVisible = useTool((s) => s.visibility.annotations);
  // v2.6 — Info dialog (CVAT-style task overview + per-class stats).
  // Aggregates from the in-memory annotations store; no extra API calls.
  const [infoOpen, setInfoOpen] = useState(false);
  // v2.9 P0-4: replaces the previous `window.prompt("Rename class", …)`
  // with an in-app Radix Dialog. Local state is plenty — only one site
  // uses this flow.
  const [renameClass, setRenameClass] = useState<{ id: string; name: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
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

  // v2.7 — drag-resizable right panel. Width persists to localStorage so the
  // user's choice survives reload; canvas fills the remaining space and the
  // existing Pixi ResizeObserver picks up the layout change for free.
  const rightPanel = useResizableRightPanel();

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
    // v3.2 Issue 1: presigned MinIO URLs change identity on every refetch,
    // and the canvas's texture-swap effect previously re-armed autoFit on
    // every imageUrl change → user lost their zoom on every window focus.
    // The autoFit logic is now gated on assetId, but disabling the
    // window-focus refetch also avoids needless network churn.
    refetchOnWindowFocus: false,
  });
  // v3.1 Issue 3 (Option A) — the editor consumes the *task-effective*
  // class list. When the task has no subset configured (allowed_class_ids
  // is null) the backend returns the full project list, preserving the
  // pre-v3.1 behaviour. When a subset is configured the editor only sees
  // those classes (annotations referencing other classes are kept in the
  // DB but hidden from new-class pickers).
  const taskClassesQ = useQuery({
    queryKey: ["task-classes", projectId, taskId],
    queryFn: () => tasksApi.getClasses(projectId, taskId),
    // v3.2 Issue 1: avoid refetching the class list every window focus;
    // the editor's canvas (and its derived classMap) doesn't need to
    // remount because the user tabbed away.
    refetchOnWindowFocus: false,
  });
  // Adapt the response shape so all downstream readers keep working
  // against a flat ``ClassRow[]`` like before.
  const classesQ = {
    data: taskClassesQ.data?.classes,
    isLoading: taskClassesQ.isLoading,
    error: taskClassesQ.error,
  } as const;

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

  // v2.9 P2 F4 — single pass over classesQ.data builds all three maps so
  // we don't loop the same array three times every time it changes.
  // - `colors` flows into the canvas as a prop (formerly a CustomEvent;
  //   see audit bug H for the timing race that motivated this change).
  // - `names` is consumed by the canvas's floating bbox label tags when
  //   the `labels` visibility flag is on (audit bug O).
  // - `byId` is consumed by ObjectsPanel so the CVAT-style filter
  //   evaluator can resolve `label` rules (v2.6).
  const classMaps = useMemo(() => {
    type ClassRow = NonNullable<typeof classesQ.data>[number];
    const empty: {
      colors: Record<string, string>;
      names: Record<string, string>;
      byId: Record<string, ClassRow>;
    } = { colors: {}, names: {}, byId: {} };
    if (!classesQ.data) return empty;
    const colors: Record<string, string> = {};
    const names: Record<string, string> = {};
    const byId: Record<string, ClassRow> = {};
    for (const c of classesQ.data) {
      colors[c.id] = c.color;
      names[c.id] = c.name;
      byId[c.id] = c;
    }
    return { colors, names, byId };
  }, [classesQ.data]);
  const classColorMap = classMaps.colors;
  const classNameMap = classMaps.names;
  const classByIdMap = classMaps.byId;

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
  // v3.1 Issue 3 — class CRUD still hits the project-level endpoints, but
  // we invalidate the per-task ``task-classes`` query since that's what
  // the editor actually consumes after the Option A subset switch.
  const invalidateClassesQueries = () => {
    qc.invalidateQueries({ queryKey: ["classes", projectId] });
    qc.invalidateQueries({ queryKey: ["task-classes", projectId, taskId] });
  };
  const classCreate = useMutation({
    mutationFn: (input: ClassIn) => classesApi.create(projectId, input),
    onSuccess: () => invalidateClassesQueries(),
    // v3.2 Issue 7 — surface the 409 duplicate-name error as a toast so the
    // user understands why the create silently no-op'd. `pendingName` is
    // captured from the mutation variables (TanStack Query passes them as
    // the second argument to onError).
    onError: (err: unknown, variables: ClassIn) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response
        ?.data?.detail;
      const pendingName = variables.name;
      if (detail === "class_idx_or_name_conflict") {
        showToast(
          `A class named "${pendingName}" already exists in this project.`,
          { variant: "error" },
        );
      } else {
        showToast("Failed to add class.", { variant: "error" });
      }
    },
  });
  const classUpdate = useMutation({
    mutationFn: ({ cid, patch }: { cid: string; patch: Partial<ClassIn> }) =>
      classesApi.update(projectId, cid, patch),
    onSuccess: () => invalidateClassesQueries(),
  });
  const classRemove = useMutation({
    mutationFn: (cid: string) => classesApi.delete(projectId, cid),
    onSuccess: () => invalidateClassesQueries(),
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
      // v2.9 P2 F1 — collapse n setState calls into one pass.
      const updates = res.updated;
      if (updates.length > 0) {
        useAnnotations.setState((s) => ({
          byId: updates.reduce(
            (acc, u) => ({
              ...acc,
              [u.id]: acc[u.id] ? { ...acc[u.id], dirty: false } : acc[u.id],
            }),
            s.byId,
          ),
        }));
      }
      useAnnotations.getState().clearPendingDeletes();
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
    },
    onError: () => {
      // v2.9 P1-15 — surface save failures via the toast bus in addition
      // to the SaveIndicator pill so the user notices when the editor
      // can't reach the server. Retry logic is unchanged: annotations
      // stay marked `dirty` and the debounced retry loop continues.
      showToast(
        "Save failed — we'll keep trying. Check your connection or refresh.",
        { variant: "error" },
      );
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

  // v2.9 P1-13 — memoize zoom callbacks. Inline arrows changed identity
  // every render, which forced EditorToolbar's keydown useEffect to
  // re-bind on every parent render (the effect lists these as deps).
  // Empty deps are correct because each callback only dispatches a
  // window CustomEvent — no closure state.
  // Hooks must run unconditionally, so these stay above the loading /
  // error early returns below.
  const handleZoomIn = useCallback(() => {
    window.dispatchEvent(new CustomEvent("carve:zoom-in"));
  }, []);
  const handleZoomOut = useCallback(() => {
    window.dispatchEvent(new CustomEvent("carve:zoom-out"));
  }, []);
  const handleZoomTo = useCallback((p: number) => {
    if (p === 0) {
      window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
    } else {
      window.dispatchEvent(
        new CustomEvent("carve:zoom-to", { detail: { pct: p } }),
      );
    }
  }, []);
  const handleZoomActual = useCallback(() => {
    window.dispatchEvent(new CustomEvent("carve:zoom-actual"));
  }, []);
  const handleFitToScreen = useCallback(() => {
    window.dispatchEvent(new CustomEvent("carve:fit-to-screen"));
  }, []);

  // v2.9 P2 G3 — memoize TopBar.rightAction so it doesn't allocate a new
  // element on every render (which would force TopBar's children to reconcile
  // even when nothing relevant changed). Hooks must run unconditionally,
  // so this stays above the loading / error early returns.
  const rightAction = useMemo(
    () => (
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
    ),
    [imageStatus, taskAssets, currentAssetIdx, prevAsset, nextAsset],
  );

  // Only show the full-page loading screen on initial mount (no data yet).
  // During asset navigation, `assetQ.data` still holds the previous asset
  // thanks to `placeholderData`, so we render the full editor and let the
  // canvas + status badge surface the in-flight state. v2.5 perf fix.
  //
  // v3.2 Issue 1: gate on `taskClassesQ.isLoading` (initial fetch only)
  // rather than `!classesQ.data`. A transient refetch can briefly hand
  // back `undefined` from `taskClassesQ.data?.classes`, which would
  // otherwise unmount the canvas (and the user's zoom + Pixi state).
  if (!assetQ.data || taskClassesQ.isLoading) {
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
      <TopBar crumbs={crumbs} rightAction={rightAction} />

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
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onZoomTo={handleZoomTo}
            onZoomActual={handleZoomActual}
            onFitToScreen={handleFitToScreen}
            onUndo={() => useAnnotations.getState().undo()}
            onRedo={() => useAnnotations.getState().redo()}
            onAfterYoloPredict={() => {
              qc.invalidateQueries({ queryKey: ["annotations", taskId] });
            }}
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
                    "bg-[oklch(0_0_0/0.40)] backdrop-blur-[2px]",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[420px] rounded-[var(--radius-lg)]",
                      "glass-surface-strong p-4 grid gap-2.5",
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

            <div
              data-testid="right-panel-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize classes panel"
              ref={rightPanel.handleRef}
              className={cn(
                "relative w-[4px] shrink-0 cursor-col-resize select-none",
                "bg-[var(--border-subtle)] hover:bg-[var(--accent)]",
                "transition-colors",
                rightPanel.isDragging && "bg-[var(--accent)]",
              )}
            >
              {/*
                Wider invisible hit zone so the 4px visual divider is easier
                to grab. -2px on each side keeps the click target ~8px without
                visually thickening the line. pointer-events:auto so the drag
                still starts here even when the cursor is between the visual
                line and the panel content.
              */}
              <span
                aria-hidden
                className="absolute inset-y-0 -left-1 -right-1"
              />
            </div>
            <aside
              role="complementary"
              aria-label="Classes"
              data-testid="right-panel-aside"
              style={{ width: `${rightPanel.width}px` }}
              className={cn(
                "relative shrink-0 flex flex-col",
                // Glass-strong right panel — only the LEFT rim border is
                // styled (a hairline that separates the panel from the
                // canvas) so the panel reads as "emerging from the right
                // edge" rather than a fully bordered card.
                "glass-surface-strong",
                "border-y-0 border-r-0 border-l border-[var(--glass-border)]",
              )}
            >
              <Tabs.Root defaultValue="classes" className="relative flex-1 min-h-0 flex flex-col">
                <Tabs.List
                  aria-label="Side panel"
                  className="flex shrink-0 border-b border-[var(--glass-border)] px-2 pt-2 gap-1 bg-transparent"
                >
                  <Tabs.Trigger
                    value="classes"
                    className={cn(
                      "px-2.5 py-1.5 text-[12px] tracking-tight rounded-full",
                      "text-[color:var(--text-tertiary)]",
                      "hover:text-[color:var(--text-primary)] hover:bg-[var(--glass-bg-subtle)]",
                      "data-[state=active]:text-[color:var(--text-primary)]",
                      "data-[state=active]:bg-[var(--glass-bg-subtle)]",
                      "data-[state=active]:shadow-[inset_0_1px_0_var(--glass-highlight),0_0_0_1px_var(--glass-border)]",
                      "transition-all duration-150",
                    )}
                  >
                    Classes
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="objects"
                    className={cn(
                      "px-2.5 py-1.5 text-[12px] tracking-tight rounded-full",
                      "text-[color:var(--text-tertiary)]",
                      "hover:text-[color:var(--text-primary)] hover:bg-[var(--glass-bg-subtle)]",
                      "data-[state=active]:text-[color:var(--text-primary)]",
                      "data-[state=active]:bg-[var(--glass-bg-subtle)]",
                      "data-[state=active]:shadow-[inset_0_1px_0_var(--glass-highlight),0_0_0_1px_var(--glass-border)]",
                      "transition-all duration-150",
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
                    currentFrameId={frameId}
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
                      setRenameClass({ id: cls.id, name: cls.name });
                      setRenameDraft(cls.name);
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

      <Dialog
        open={renameClass !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRenameClass(null);
            setRenameDraft("");
          }
        }}
      >
        <DialogContent className="w-[min(92vw,420px)]">
          <DialogHeader>
            <DialogTitle>Rename class</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!renameClass) return;
              const next = renameDraft.trim();
              if (next && next !== renameClass.name) {
                classUpdate.mutate({ cid: renameClass.id, patch: { name: next } });
              }
              setRenameClass(null);
              setRenameDraft("");
            }}
          >
            <input
              type="text"
              autoFocus
              data-testid="rename-class-input"
              aria-label="Class name"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className={cn(
                "w-full h-9 px-2.5 rounded-[var(--radius-sm)]",
                "bg-[var(--bg-subtle)] text-[color:var(--text-primary)]",
                "border border-[var(--border-subtle)]",
                "outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]",
                "text-[13px]",
              )}
            />
            <DialogFooter>
              <button
                type="button"
                onClick={() => {
                  setRenameClass(null);
                  setRenameDraft("");
                }}
                data-testid="rename-class-cancel"
                className="h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] text-[color:var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="rename-class-save"
                className={cn(
                  "h-8 px-3 rounded-[var(--radius-sm)] text-[12.5px] font-medium",
                  "bg-[var(--accent)] text-[color:var(--accent-fg)]",
                  "hover:opacity-90",
                )}
              >
                Save
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
      dot: "bg-[var(--warning)] animate-pulse",
      label: "Loading…",
      fg: "text-[var(--warning)]",
      bg: "bg-[var(--warning-bg)]",
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
        variant="glass"
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
        variant="glass"
        disabled={!nextAsset}
        onClick={() => nextAsset && onGoTo(nextAsset.id)}
      >
        <ChevronRight className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

// Armin Mehri — mehri.armin@gmail.com
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  AlertCircle,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  EyeOff,
  Info,
  Layers,
  Loader2,
  RefreshCw,
  SkipBack,
  SkipForward,
  Sliders,
  Tag,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";

import { handleOpsMessage, handleResyncMessage } from "@/realtime/applyOps";
import {
  handleHelloPresence,
  handlePresenceCursor,
  handlePresenceFocus,
  handlePresenceJoin,
  handlePresenceLeave,
} from "@/realtime/applyPresence";
import { usePresence } from "@/realtime/presence";
import { useTaskStream } from "@/realtime/useTaskStream";
import type { RealtimeClient } from "@/realtime/ws";
import type { ClientPresenceCursor, ClientPresenceFocus } from "@/realtime/types";
import { AnnotationCanvas, type ImageLoadStatus } from "@/components/annotation/AnnotationCanvas";
import { PresenceChips } from "@/components/annotation/PresenceChips";
import { PresenceConnectionStatus } from "@/components/annotation/PresenceConnectionStatus";
import {
  PresenceCursorLayer,
  type CanvasTransform,
} from "@/components/annotation/PresenceCursorLayer";
import { PresenceFocusLayer } from "@/components/annotation/PresenceFocusLayer";
import { ClassesPanel } from "@/components/annotation/ClassesPanel";
import { CommandPalette } from "@/components/annotation/CommandPalette";
import { FrameTimeline } from "@/components/annotation/FrameTimeline";
import { InfoDialog } from "@/components/annotation/InfoDialog";
import { ObjectsPanel } from "@/components/annotation/ObjectsPanel";
import { HealthPanel } from "@/components/annotation/HealthPanel";
import { ReviewPanel } from "@/components/annotation/ReviewPanel";
import { AppearancePanel } from "@/components/annotation/AppearancePanel";
import { TrackPanel } from "@/components/annotation/TrackPanel";
import { TrackProgressBadge } from "@/components/annotation/TrackProgressBadge";
import { useTrackBridge } from "@/state/trackBridge";
import { useSamTrackBridge } from "@/state/samTrackBridge";
import { trackApi } from "@/api/track";
import { EditorToolbar } from "@/components/annotation/EditorToolbar";
import { ClearRangeDialog } from "@/components/annotation/ClearRangeDialog";
import { KeyboardCheatSheet } from "@/components/annotation/KeyboardCheatSheet";
import { SelectionCountBadge } from "@/components/annotation/SelectionCountBadge";
import { AssetThumbnailStrip } from "@/components/annotation/AssetThumbnailStrip";
import { SamUnavailableBanner } from "@/components/annotation/SamUnavailableBanner";
import { ResumeProgressBanner } from "@/components/annotation/ResumeProgressBanner";
import { SavedViewsMenu } from "@/components/search/SavedViewsMenu";
import { viewsApi, type SavedView, type SavedViewQuery } from "@/api/views";
import { TopBar } from "@/components/nav/TopBar";
import { LeftNav } from "@/components/nav/LeftNav";
import { BottomBar } from "@/components/nav/BottomBar";
import { IconButton } from "@/components/ui/IconButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { annotationsApi, type BatchPayload } from "@/api/annotations";
import {
  bulkConvertSelectedToBboxWithToast,
  bulkConvertPolygonsOnFrameToBboxWithToast,
  bulkConvertPolygonsInTaskToBboxWithToast,
  bulkClearTaskAnnotationsWithToast,
  countPolygonsOnFrame,
} from "@/lib/bulkConvert";
import { assetsApi } from "@/api/assets";
import { classesApi, type ClassIn } from "@/api/classes";
import { projectsApi } from "@/api/projects";
import { tasksApi } from "@/api/tasks";
import { useProjectSamReconcile } from "@/hooks/useProjectSamReconcile";
import { useUsers, displayNameFor } from "@/api/users";
import { useAnnotations } from "@/state/annotations";
import { useAuth } from "@/auth/store";
import { useTool } from "@/state/tool";
import { useEditorSettings } from "@/state/editorSettings";
import { useProjectPrefs } from "@/state/projectPrefs";
import { useFilter } from "@/state/annotationFilter";
import { hasMeaningfulRules } from "@/lib/annotation-filter";
import {
  applyLocalAssetOverride,
  computeFilteredNeighbours,
  computeMatchingAssetIds,
} from "@/lib/annotation-filter-nav";
import { useShortcutHandler, useShortcutsQuery } from "@/state/shortcuts";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { matchChord } from "@/lib/shortcuts/chord";
import { useResizableRightPanel } from "@/hooks/useResizableRightPanel";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { BackgroundJobsLeaveGuard } from "@/components/BackgroundJobsLeaveGuard";
import { keybindingsApi } from "@/api/keybindings";
import { effectiveBindings } from "@/lib/class-keybindings";
import { copyAnnotationsFromAssetTo } from "@/lib/copy-from-asset";
import {
  CopyAnnotationsDialog,
  type BreakdownCounts,
} from "@/components/annotation/CopyAnnotationsDialog";
import { CopyFromPromptDialog } from "@/components/annotation/CopyFromPromptDialog";
import { ThumbContextMenu } from "@/components/annotation/ThumbContextMenu";
import {
  findNextEmptyAsset,
  findNextUnreviewedAsset,
  type SkipDirection,
} from "@/lib/asset-skip-nav";

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
  onContextMenuCopy,
}: {
  taskId: string;
  projectId: string;
  activeAssetId: string;
  onContextMenuCopy?: (
    assetId: string,
    pos: { x: number; y: number },
  ) => void;
}) {
  const enabled = useTool((s) => s.visibility.thumbnails);
  if (!enabled) return null;
  return (
    <AssetThumbnailStrip
      taskId={taskId}
      projectId={projectId}
      activeAssetId={activeAssetId}
      onContextMenuCopy={onContextMenuCopy}
    />
  );
}

/**
 * v3.5 Phase E — gate that mounts the SAM video tracking panel only
 * when the user is on a video asset, has the SAM tool active, and has
 * picked the "track" mode. Lifted out of AnnotateAssetPage's render so
 * the page itself doesn't re-render on every tool / mode transition.
 */
function SamTrackModeGate({
  assetId,
  frameId,
  currentFrameIdx,
  totalFrames,
  isVideo,
  frameIdxToFrameId,
  classes,
}: {
  assetId: string;
  frameId: string | null;
  currentFrameIdx: number;
  totalFrames: number;
  isVideo: boolean;
  frameIdxToFrameId?: Record<number, string>;
  classes?: import("@/api/classes").ClassRow[];
}) {
  const activeTool = useTool((s) => s.active);
  const samMode = useTool((s) => s.samMode);
  if (!isVideo) return null;
  if (activeTool !== "sam") return null;
  if (samMode !== "track") return null;
  return (
    <TrackPanel
      assetId={assetId}
      currentFrameIdx={currentFrameIdx}
      totalFrames={totalFrames}
      frameIdxToFrameId={frameIdxToFrameId ?? {}}
      classes={classes ?? []}
    />
  );
}

export function AnnotateAssetPage({ projectId, taskId, assetId }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Reset the toolbar to the default "Drag" (cursor) tool every time
  // the editor mounts. `useTool` is a module-level zustand store so its
  // state survives the SPA-level navigation back to /projects and
  // re-entry; without this reset a previously chosen Smart Tool ▸
  // Point / Bbox / Text / Track stays selected, which surprises users
  // who expect a clean Drag mode on re-entry.
  useEffect(() => {
    const tool = useTool.getState();
    tool.setActive("cursor");
    tool.setSamMode("point");
    // Mount-only: NOT on assetId / taskId change. Switching assets
    // inside the editor should preserve the current tool choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // v3.30 — record this task as the user's most-recently-touched
  // task in this project. Drives the Resume button on the project
  // detail page so reopening the project jumps you back to the work
  // you were just doing, not just the newest task by created_at.
  const recordTaskVisit = useProjectPrefs((s) => s.recordTaskVisit);
  useEffect(() => {
    recordTaskVisit(projectId, taskId);
  }, [projectId, taskId, recordTaskVisit]);

  // Realtime collaboration. Phase 4 wires data sync; Phase 6 layers
  // presence (chips + cursors). Recovery: a previous edit cycle lost
  // the page-level useTaskStream mount, so Phase 4 shipped silently
  // disabled — this restores it AND adds the Phase 6 callbacks in one
  // pass. The store holds OTHER users; the transport keeps it in sync
  // via the on* callbacks. We capture the live client in a ref so the
  // throttled cursor + focus emitters can call ``client.send``
  // synchronously from event handlers.
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  realtimeClientRef.current = useTaskStream({
    taskId,
    onHello: handleHelloPresence,
    // Phase 7.5 — gate inbound upserts by the local frame so a
    // teammate drawing on image 200 doesn't briefly flash on user
    // B's canvas while they're viewing image 360. ``frameIdRef`` is
    // already a live ref of the current asset's frame_id; reading
    // it inside the callback picks up frame switches without
    // re-mounting the WS.
    onOps: (msg) =>
      handleOpsMessage(msg, { currentFrameId: frameIdRef.current }),
    onResync: (msg) => handleResyncMessage(qc, taskId, msg),
    onPresence: (msg) => {
      switch (msg.type) {
        case "presence:join":
          handlePresenceJoin(msg);
          break;
        case "presence:leave":
          handlePresenceLeave(msg);
          break;
        case "presence:cursor":
          handlePresenceCursor(msg);
          break;
        case "presence:focus":
          handlePresenceFocus(msg);
          break;
      }
    },
  });
  // Drop stale presence state on task switch + on unmount so a brief
  // mount window doesn't show prior teammates' avatars.
  useEffect(() => {
    usePresence.getState().reset();
    return () => usePresence.getState().reset();
  }, [taskId]);

  // Phase 6 — the canvas transform feeds the presence cursor overlay.
  // AnnotationCanvas calls ``onTransformChange`` whenever ``applyFrame``
  // runs (zoom / pan), and the overlay re-projects image-space cursors
  // into wrapper-local pixel coords on the next render.
  const [canvasTransform, setCanvasTransform] = useState<CanvasTransform>({
    scale: 1,
    offset: { x: 0, y: 0 },
  });

  // Phase 6 — outbound presence:cursor with a 50 ms (20 Hz) throttle.
  // The server caps at 33 ms (~30 Hz) so we always stay under the
  // defensive ceiling. ``perfNow`` is held in a ref so callback
  // identity stays stable across re-renders.
  const lastCursorSendRef = useRef(0);
  const handlePointerMoveImage = useCallback(
    (imgX: number, imgY: number) => {
      const client = realtimeClientRef.current;
      if (!client) return;
      const now = performance.now();
      if (now - lastCursorSendRef.current < 50) return;
      lastCursorSendRef.current = now;
      // ``presence:cursor`` is best-effort: if the WS is closed the
      // send is dropped silently inside RealtimeClient.send.
      const msg: ClientPresenceCursor = {
        v: 1,
        type: "presence:cursor",
        asset_id: assetId,
        // frame_id intentionally omitted — the resolved video frame
        // uuid lives behind a query and the cursor layer doesn't need
        // it (it filters by asset_id).
        x: imgX,
        y: imgY,
      };
      client.send(msg);
    },
    [assetId],
  );

  // Phase 6 — outbound presence:focus. Tracks the *resolved* serverId
  // of the locally-selected annotation so a unsaved optimistic draft
  // (no serverId yet) doesn't trigger a broadcast. Re-fires only when
  // the resolved id changes; Zustand's referential equality keeps it
  // cheap.
  const focusServerId = useAnnotations((s) => {
    const id = s.selectedId;
    if (!id) return null;
    return s.byId[id]?.serverId ?? null;
  });
  useEffect(() => {
    const client = realtimeClientRef.current;
    if (!client) return;
    const msg: ClientPresenceFocus = {
      v: 1,
      type: "presence:focus",
      target: focusServerId
        ? { kind: "annotation", id: focusServerId }
        : null,
    };
    client.send(msg);
  }, [focusServerId]);

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
  // v3.24.8 — ``visibility.annotations`` is consumed directly by
  // AnnotationCanvas via ``useTool.getState().visibility`` (see
  // AnnotationCanvas.tsx:1103) and by the right-rail footer toolbar.
  // No page-level subscription needed any more.
  // v2.6 — Info dialog (CVAT-style task overview + per-class stats).
  // Aggregates from the in-memory annotations store; no extra API calls.
  const [infoOpen, setInfoOpen] = useState(false);
  // Plan-15 Phase 9 follow-up — toolbar dispatches this event so the
  // Info trigger can live next to the gear without prop-drilling.
  useEffect(() => {
    const onOpen = () => setInfoOpen((v) => !v);
    window.addEventListener("carve:open-info-dialog", onOpen as EventListener);
    return () =>
      window.removeEventListener(
        "carve:open-info-dialog",
        onOpen as EventListener,
      );
  }, []);
  // v2.9 P0-4: replaces the previous `window.prompt("Rename class", …)`
  // with an in-app Radix Dialog. Local state is plenty — only one site
  // uses this flow.
  const [renameClass, setRenameClass] = useState<{ id: string; name: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // ----- Plan-13 Phase 7 Task 9: saved views ---------------------------------
  // The active view's filters are tracked at the page level so future child
  // components (e.g. ReviewPanel) can consume them; the URL is kept in sync
  // with `?view=<id>` so reloading the page restores the user's selection.
  const initialViewId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("view")
      : null;
  const initialStatus =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("status")
      : null;
  const [activeViewId, setActiveViewId] = useState<string | null>(initialViewId);
  const [appliedQuery, setAppliedQuery] = useState<SavedViewQuery>(() => {
    if (initialViewId) return {};
    if (
      initialStatus === "proposed" ||
      initialStatus === "accepted" ||
      initialStatus === "rejected"
    ) {
      return { status: initialStatus };
    }
    return {};
  });

  // Resolve `?view=<id>` on mount → load the view, apply filters, hydrate URL.
  useEffect(() => {
    if (!initialViewId) return;
    let cancelled = false;
    void viewsApi
      .get(initialViewId)
      .then((view) => {
        if (cancelled) return;
        setAppliedQuery(view.query ?? {});
      })
      .catch(() => {
        if (cancelled) return;
        // Fallback silently — bad/expired view IDs shouldn't break the page.
        setActiveViewId(null);
      });
    return () => {
      cancelled = true;
    };
    // We intentionally only run this once on mount. Subsequent selections go
    // through `applySavedView` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySavedView = useCallback((view: SavedView) => {
    setActiveViewId(view.id);
    setAppliedQuery(view.query ?? {});
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("view", view.id);
      url.searchParams.delete("status");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);
  // Intentionally read so the linter doesn't drop the reference; future
  // children consume `appliedQuery` to drive their filters.
  void appliedQuery;
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
  // v3.32 — reconcile the project's persisted preferred SAM variant
  // with what's actually loaded on the model service. Asks the user
  // once per session (per project) if there's a mismatch; no-op when
  // the project has no preference set.
  useProjectSamReconcile(projectId);
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
  // v3.8 Phase 4-video step C — frames-list query for video assets.
  // Returns ``[{idx, frame_id, pts_ms, url}, ...]`` ordered by idx.
  // Polls every 3s while empty so the editor catches up to the
  // background extraction worker without a manual refresh.
  const framesQ = useQuery({
    queryKey: ["frames", assetId],
    queryFn: () => assetsApi.listFrames(assetId),
    enabled: assetQ.data?.asset.kind === "video",
    refetchInterval: (q) => {
      // Fast-poll while no frames exist yet (extraction in flight or
      // legacy upload pending Re-extract). Stop once any frame is
      // present or once the asset isn't a video.
      const data = q.state.data;
      if (!data || data.length <= 1) return 3000;
      return false;
    },
    staleTime: 30_000,
  });
  // v3.8 Phase 4-video step F8 — the SAM video tracker iterates over
  // the stitched JPEG sequence and emits POSITIONAL frame indices
  // (0..N-1), not the raw video indices stored on the Frame rows.
  // Key the commit map by array position so every propagated frame
  // matches a frame_id; otherwise sparse extractions drop almost all
  // tracked frames at commit time ("Tracked N frames, committed 0").
  const frameIdxToFrameId = useMemo(() => {
    const map: Record<number, string> = {};
    (framesQ.data ?? []).forEach((f, i) => {
      map[i] = f.frame_id;
    });
    return map;
  }, [framesQ.data]);

  // v3.8 Phase 4-video step F — frame-extraction progress polling.
  // Active only while we're a video asset AND frames are still empty
  // (extraction in progress / not yet started). Stops once any frame
  // is present so the editor doesn't keep hammering Redis.
  const isVideoAsset = assetQ.data?.asset.kind === "video";
  // Only treat the asset as "missing frames" once the frames query has
  // actually resolved at least once. Before that, ``framesQ.data`` is
  // ``undefined`` and `(undefined ?? []).length === 0` evaluates true —
  // which previously made every page refresh briefly look like an empty
  // video and triggered the "Frames still extracting" toast / redirect
  // even when 2 230 frames already existed in the DB.
  const noFramesYet = framesQ.isFetched && (framesQ.data ?? []).length === 0;
  const extractStatusQ = useQuery({
    queryKey: ["frame-extract-status", assetId],
    queryFn: () => assetsApi.frameExtractStatus(assetId),
    enabled: isVideoAsset && noFramesYet,
    refetchInterval: isVideoAsset && noFramesYet ? 800 : false,
    refetchIntervalInBackground: false,
  });

  // v3.26 — defense-in-depth guard. If the user lands here on a video
  // whose frames haven't been extracted AND there is no in-flight
  // extract job, send them back to the task page with an info toast.
  // Normal flow blocks the click via the AssetGrid card overlay; this
  // catches stale URLs / direct-paste navigation. Waits for BOTH the
  // frames query and the extract-status query to resolve before
  // deciding — premature redirect would trip on the initial undefined
  // state of framesQ.data and bounce the user out on every refresh.
  useEffect(() => {
    if (!isVideoAsset) return;
    if (!framesQ.isFetched) return;
    if (!noFramesYet) return;
    const status = extractStatusQ.data?.status;
    if (status === undefined || status === "running") return;
    showToast("Frames still extracting — opening when ready", {
      variant: "info",
    });
    void navigate({
      to: "/projects/$projectId/tasks/$taskId",
      params: { projectId, taskId },
    });
  }, [
    isVideoAsset,
    framesQ.isFetched,
    noFramesYet,
    extractStatusQ.data?.status,
    navigate,
    projectId,
    taskId,
  ]);
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
    // Always refetch the task-effective class list on editor mount.
    // The user may have added classes to the project and/or assigned
    // them to this task from a separate page (ClassesEditor,
    // ProjectDetailPage's "Assign classes" dialog, etc.) while the
    // cached entry was still considered fresh by the global 30 s
    // staleTime. Without this, re-entering the editor served the
    // pre-assignment cache and the classes panel / Auto-Annotate /
    // Smart Find rows looked empty until a hard refresh.
    refetchOnMount: "always",
    staleTime: 0,
  });
  // Adapt the response shape so all downstream readers keep working
  // against a flat ``ClassRow[]`` like before.
  const classesQ = {
    data: taskClassesQ.data?.classes,
    isLoading: taskClassesQ.isLoading,
    error: taskClassesQ.error,
  } as const;

  const keybindingsQ = useQuery({
    queryKey: ["class-keybindings", projectId],
    queryFn: () => keybindingsApi.list(projectId),
    staleTime: 60_000,
  });

  // Single source of truth for digit→class. Mirrors the server-side
  // composition; recomputes when classes or stored bindings change so
  // optimistic mutations re-render the kbd badges instantly.
  const digitToClassId = useMemo(
    () => effectiveBindings(
      keybindingsQ.data?.bindings ?? [],
      classesQ.data ?? [],
    ),
    [keybindingsQ.data, classesQ.data],
  );

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
    // v3.33 — gate on ``assetQ`` resolving so the unscoped fetch never
    // fires. On a cold open the first render has ``assetQ.data ===
    // undefined`` so ``frameId`` is null; the prior code still fired
    // ``listForTask(taskId, undefined)``, and the server treats a
    // missing ``frame_id`` as "every annotation in the task". For an
    // auto-annotated 3600-image task (SAM3 polygons or YOLO bboxes)
    // that response is tens of megabytes; the parse blocks the event
    // loop long enough that the correctly-scoped per-frame refetch
    // can't complete before the canvas paints. Symptom the user saw:
    // annotations don't appear on the first image, and only do after
    // navigating back and forth (which forces a fresh per-frame fetch
    // long after the giant unscoped one has drained).
    enabled: assetQ.data != null,
  });

  // Plan-09b Task 4 — workspace members for reviewer-name resolution. The
  // ``ReviewPanel`` accepts a ``resolveReviewerName(userId) => string | null``
  // prop and renders ``<name> · <relative time>`` when a reviewer was
  // recorded. We memoize an id→name map so the resolver doesn't allocate on
  // every render.
  const usersQ = useUsers();
  const reviewerNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const u of usersQ.data ?? []) {
      map[u.id] = displayNameFor(u);
    }
    return map;
  }, [usersQ.data]);
  const resolveReviewerName = useMemo(
    () => (userId: string): string | null => reviewerNameById[userId] ?? null,
    [reviewerNameById],
  );

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

  // Clear undo/redo history on true scope changes (asset or frame).
  // `reset()` preserves history so autosave-driven refetches don't wipe
  // Cmd+Z; this effect handles the legitimate "different image" case.
  useEffect(() => {
    useAnnotations.setState({
      history: { past: [], future: [] },
      lastEditMeta: null,
    });
  }, [assetId, frameId]);

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
  //
  // v3.x — filter-aware: when an annotation filter is active
  // (e.g. ``label == bus``) arrow navigation must skip non-matching
  // assets so the user lands on the next image that actually contains
  // a Bus instead of stepping through every blank image first.
  // The fallback (plain adjacency) is preserved when no filter rule
  // has a non-empty value.
  const taskAssets = taskAssetsQ.data ?? [];
  const currentAssetIdx = taskAssets.findIndex((a) => a.id === assetId);

  const activeFilter = useFilter((s) => s.filter);
  const filterActive = useMemo(
    () => hasMeaningfulRules(activeFilter),
    [activeFilter],
  );

  // Raw annotations across the entire task — required to group by
  // ``asset_id`` so we can ask "which assets contain a Bus?". Gated on
  // ``filterActive`` so unfiltered sessions don't pay the network /
  // memory cost. ``staleTime: 0`` keeps the matching set fresh after
  // edits; React Query dedupes against the per-frame query so the
  // network savings are real for warm caches.
  const taskAnnotationsRawQ = useQuery({
    queryKey: ["task-annotations-raw", taskId],
    queryFn: () => annotationsApi.listForTaskRaw(taskId),
    enabled: filterActive,
    staleTime: 0,
  });

  // Live subscription to the local annotations store. Lets the matching
  // memo re-evaluate the CURRENT asset's membership the instant the
  // user adds/deletes an annotation — the cached task-wide query
  // refreshes only after autosave flushes (debounced ~1s), so without
  // this override the user reported arrow nav still landing on assets
  // whose last matching annotation they'd just deleted.
  const liveAnnotationsById = useAnnotations((s) => s.byId);

  const matchingAssetIds = useMemo(() => {
    if (!filterActive) return new Set<string>();
    const raw = taskAnnotationsRawQ.data ?? [];
    const serverMatching = computeMatchingAssetIds(
      raw, classByIdMap, activeFilter,
    );
    // Override the current asset's bit with the live store so deletes/
    // adds register immediately. ``assetId`` may be undefined during
    // initial mount before the route resolves — in that case the
    // override is a no-op.
    const localAnnotations = Object.values(liveAnnotationsById);
    return applyLocalAssetOverride(
      serverMatching,
      assetId ?? null,
      localAnnotations,
      classByIdMap,
      activeFilter,
    );
  }, [
    filterActive,
    taskAnnotationsRawQ.data,
    classByIdMap,
    activeFilter,
    liveAnnotationsById,
    assetId,
  ]);

  const { prev: prevAsset, next: nextAsset } = useMemo(
    () => computeFilteredNeighbours(taskAssets, currentAssetIdx, matchingAssetIds),
    [taskAssets, currentAssetIdx, matchingAssetIds],
  );

  const navAssetRef = useRef<{ prev: typeof prevAsset; next: typeof nextAsset }>({
    prev: prevAsset,
    next: nextAsset,
  });
  navAssetRef.current = { prev: prevAsset, next: nextAsset };

  // Prefetch prev/next asset metadata + warm the browser image cache for
  // their thumbnails. When the user hits ArrowLeft/Right the new asset's
  // query is already populated, so navigation is near-instant. v2.5 perf
  // fix.
  //
  // v3.29 — the image warm-up is deferred to requestIdleCallback so the
  // in-flight prefetch fetches don't keep Chrome's tab spinner spinning
  // after the active asset has already rendered. Detached `new Image()`
  // requests count as page resources for the tab-load indicator until
  // they settle; deferring them past the document `load` event makes
  // them pure idle-time work that doesn't drive the spinner.
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
    }
    type IdleScheduler = (cb: () => void) => unknown;
    const ric: IdleScheduler =
      (window as unknown as { requestIdleCallback?: IdleScheduler })
        .requestIdleCallback ?? ((cb) => window.setTimeout(cb, 200));
    const handles: unknown[] = [];
    for (const t of targets) {
      if (!t.thumb) continue;
      handles.push(
        ric(() => {
          // Warm the browser image cache so the thumbnail strip + future
          // <img> renders are an immediate cache hit. Loading in idle
          // time means the request does not contribute to the tab's
          // loading indicator after the active asset has rendered.
          const img = new Image();
          img.decoding = "async";
          img.src = t.thumb as string;
        }),
      );
    }
    return () => {
      const cancelIdle = (
        window as unknown as { cancelIdleCallback?: (h: unknown) => void }
      ).cancelIdleCallback;
      for (const h of handles) {
        if (cancelIdle) cancelIdle(h);
        else window.clearTimeout(h as number);
      }
    };
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
        useAnnotations.setState((s) => {
          // ``u.id`` is the SERVER id of the updated annotation. After
          // the dirty-safe reset preserves the local tempId across
          // refetches, byId may key entries by tempId (not server.id).
          // Match on either to avoid (a) missing the clear, and (b)
          // writing ``undefined`` into byId — a previous version did
          // ``[u.id]: acc[u.id] ? … : acc[u.id]`` which poisoned the
          // map when the server id wasn't a key, producing the
          // "Cannot read properties of undefined (reading 'dirty')"
          // crash the next time anything iterated byId.
          const updatedIds = new Set(updates.map((u) => u.id));
          const next: typeof s.byId = {};
          for (const [tempId, draft] of Object.entries(s.byId)) {
            const matchesByKey = updatedIds.has(tempId);
            const matchesByServerId =
              draft.serverId !== null && updatedIds.has(draft.serverId);
            if (matchesByKey || matchesByServerId) {
              next[tempId] = { ...draft, dirty: false };
            } else {
              next[tempId] = draft;
            }
          }
          return { byId: next };
        });
      }
      useAnnotations.getState().clearPendingDeletes();
      qc.invalidateQueries({ queryKey: ["annotations", taskId] });
      // Filter-aware nav reads from this task-wide raw query to decide
      // which assets contain matching annotations. After autosave the
      // server reflects local edits, so the matching set must refresh
      // too — otherwise the user could delete the last Bus on the
      // CURRENT asset and arrow-nav back to it (the local-store
      // override at the page level handles the current asset; this
      // invalidation handles every OTHER asset that was edited).
      qc.invalidateQueries({ queryKey: ["task-annotations-raw", taskId] });
      // Plan-16 — refresh project-level stats so the per-task progress
      // bars and totals reflect the latest annotation count whenever
      // the user navigates back from the editor. Without this the
      // ProjectStatsStrip can sit stale at the previous percentages
      // for the React Query default staleTime (30s).
      qc.invalidateQueries({ queryKey: ["project-stats", projectId] });
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
        // Plan-17 — ship the (possibly changed) kind so the server can
        // accept Convert ▸ Polygon→BBox and BBox→Polygon transitions.
        kind: d.kind,
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

  /** Promise-returning save used by the exit guard and the asset-switch
   * flush. Resolves once the server has acknowledged the batch (so the
   * caller can safely navigate / unmount). Resolves immediately when
   * there's nothing dirty. */
  async function saveAndWait(): Promise<void> {
    const payload = buildPayload();
    if (
      payload.create.length === 0 &&
      payload.update.length === 0 &&
      payload.delete.length === 0
    ) {
      return;
    }
    await saveMutation.mutateAsync(payload);
  }

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const saveAndWaitRef = useRef(saveAndWait);
  saveAndWaitRef.current = saveAndWait;

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

  // Flush whatever's dirty before the next asset's annotations get
  // seeded. The dirty-safe `useAnnotations.reset()` already preserves
  // unsaved drafts across the asset switch, but flushing here makes the
  // save fire immediately instead of waiting for the next debounce
  // tick — so a fast operator drawing on frame A then jumping to
  // frame B doesn't see the save delayed until they slow down.
  const prevAssetIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevAssetIdRef.current && prevAssetIdRef.current !== assetId) {
      saveNowRef.current();
    }
    prevAssetIdRef.current = assetId;
  }, [assetId]);

  // Live dirty-count ref read by the navigation blocker. Direct
  // ``dirtyCount`` reads would close over the value at the time the
  // blocker is wired and never update. We pull from the store inline
  // each navigation attempt so the value is always current.
  const dirtyCountRef = useRef(0);
  useEffect(() => {
    const compute = () => {
      const s = useAnnotations.getState();
      dirtyCountRef.current =
        Object.values(s.byId).filter((d) => d.dirty).length +
        s.pendingDeletes.length;
    };
    compute();
    const unsub = useAnnotations.subscribe(compute);
    return unsub;
  }, []);

  // Tracking-in-flight detection. The leave-guard must fire when the
  // user has a Run-full-track propagation streaming, even if all the
  // polygons already happen to be flushed — closing the tab would
  // otherwise silently kill the propagation with no warning.
  const trackRunning = useTrackBridge((s) => s.status === "running");
  const trackRunningRef = useRef(trackRunning);
  trackRunningRef.current = trackRunning;

  /** Tear down a live tracking session on the way out so the model
   *  service stops streaming + frees GPU. Best-effort — failures are
   *  swallowed; the browser will also TCP-close the stream once it
   *  navigates, which the model service handles via its existing
   *  BrokenPipe path plus the 10-min idle eviction. */
  async function stopTrackingForExit(): Promise<void> {
    const sid = useTrackBridge.getState().sessionId;
    if (!sid) return;
    try {
      await trackApi.close(assetId, sid);
    } catch {
      /* best-effort */
    } finally {
      useSamTrackBridge.getState().setMarkers([]);
      useTrackBridge.getState().reset();
    }
  }

  // Exit-confirmation dialog. The blocker's ``shouldBlockFn`` returns
  // a Promise that resolves when the user clicks a button. Storing the
  // resolver here lets the buttons drive the promise from React state.
  const [exitPrompt, setExitPrompt] = useState<
    { resolve: (block: boolean) => void } | null
  >(null);
  // ``true`` while a save triggered from the dialog is in flight. The
  // dialog hides its buttons and shows a "Saving…" line so the user
  // can't double-click and triple-fire the mutation.
  const [exitSaving, setExitSaving] = useState(false);

  useBlocker({
    enableBeforeUnload: () =>
      dirtyCountRef.current > 0 || trackRunningRef.current,
    shouldBlockFn: async ({ next }) => {
      // Don't gate movement inside the same task editor — the
      // asset-switch flush effect above already drains pending changes,
      // and the dirty-safe reset preserves anything still in flight.
      if (
        typeof next.pathname === "string" &&
        next.pathname.startsWith(`/projects/${projectId}/tasks/${taskId}`)
      ) {
        return false;
      }
      if (dirtyCountRef.current === 0 && !trackRunningRef.current) {
        return false;
      }
      return await new Promise<boolean>((resolve) => {
        setExitPrompt({ resolve });
      });
    },
  });

  async function handleExitPrompt(
    choice: "save" | "discard" | "cancel",
  ): Promise<void> {
    const prompt = exitPrompt;
    if (!prompt) return;
    if (choice === "save") {
      setExitSaving(true);
      try {
        await saveAndWaitRef.current();
      } catch {
        // Save failed (network / server). The store keeps dirty
        // drafts, so the user won't lose data — but we still let
        // them exit because they explicitly chose to leave. The
        // next time they open the editor, the debounce retry loop
        // resumes from the preserved dirty state.
      } finally {
        setExitSaving(false);
      }
      await stopTrackingForExit();
      setExitPrompt(null);
      prompt.resolve(false);
      return;
    }
    if (choice === "discard") {
      useAnnotations.getState().discardLocal();
      await stopTrackingForExit();
      setExitPrompt(null);
      prompt.resolve(false);
      return;
    }
    setExitPrompt(null);
    prompt.resolve(true);
  }

  // v3.21 -- only ``Esc`` (dialog-local) stays as an inline handler;
  // ``Cmd+S`` and ``Backspace/Delete`` are now customizable through the
  // shortcut registry (``save_annotations`` and ``delete_annotation``).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.key === "Escape") {
        useAnnotations.getState().clearSelection();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId]);

  // v3.21 -- save_annotations & delete_annotation are user-customizable.
  useShortcutHandler("save_annotations", () => {
    saveNowRef.current();
  });
  useShortcutHandler("delete_annotation", () => {
    // v3.24.14 — single bulk delete instead of N synchronous remove()
    // calls. The old loop pushed one history entry per annotation and
    // queued one re-render per dispatch, which made the last selected
    // shape appear to "linger" for ~1s before being dropped.
    const ids = useAnnotations.getState().selectedIds;
    if (ids.length === 0) return;
    useAnnotations.getState().removeMany(ids);
  });

  // F1 — Copy from previous asset (mod+shift+d).
  // Duplicates every valid annotation from the previous asset in
  // ``taskAssets`` onto the current asset's current frame. Pure helper
  // does the geometry clamping + class filtering; this handler just
  // resolves the source / target / class-subset and dispatches the
  // bulk-add. v1 supports image assets only (video copy mapping needs
  // a frame-correspondence model we don't have yet).
  const runCopyFromPreviousAsset = useCallback(async () => {
    if (currentAssetIdx <= 0) {
      showToast("No previous asset to copy from.", { variant: "info" });
      return;
    }
    const prev = taskAssets[currentAssetIdx - 1];
    const curr = assetQ.data?.asset;
    if (!prev || !curr) {
      showToast("Asset metadata not loaded yet — try again in a moment.", {
        variant: "warning",
      });
      return;
    }
    if (prev.kind !== "image") {
      showToast(
        "Copy from previous asset is image-only in v1 (video coming soon).",
        { variant: "info" },
      );
      return;
    }
    if (curr.kind !== "image") {
      showToast(
        "Copy from previous asset is image-only in v1 (video coming soon).",
        { variant: "info" },
      );
      return;
    }
    const allowed = taskClassesQ.data?.allowed_class_ids ?? null;
    const allowedSet = allowed ? new Set<string>(allowed) : null;

    let result;
    try {
      result = await copyAnnotationsFromAssetTo({
        sourceAssetId: prev.id,
        targetAsset: curr,
        taskId,
        allowedClassIds: allowedSet,
        frameId: frameIdRef.current,
        qc,
      });
    } catch (err) {
      showToast(
        err instanceof Error
          ? `Couldn't load source annotations: ${err.message}`
          : "Couldn't load source annotations.",
        { variant: "error" },
      );
      return;
    }

    if (result.sourceTotal === 0) {
      showToast(
        `No annotations on previous asset "${prev.original_name}".`,
        { variant: "info" },
      );
      return;
    }
    if (result.accepted.length === 0) {
      if (result.skippedByClass > 0 && result.skippedByGeometry === 0) {
        showToast(
          `0 copied — all ${result.skippedByClass} annotations use classes not in this task.`,
          { variant: "warning" },
        );
      } else if (
        result.skippedByGeometry > 0 &&
        result.skippedByClass === 0
      ) {
        showToast(
          `0 copied — ${result.skippedByGeometry} annotations had geometry incompatible with this image.`,
          { variant: "warning" },
        );
      } else {
        showToast("Nothing valid to copy from previous asset.", {
          variant: "info",
        });
      }
      return;
    }

    useAnnotations.getState().addMany(result.accepted);
    const parts: string[] = [
      `Copied ${result.accepted.length} annotation${result.accepted.length === 1 ? "" : "s"}`,
      `from "${prev.original_name}"`,
    ];
    const tail: string[] = [];
    if (result.skippedByClass > 0)
      tail.push(`${result.skippedByClass} skipped (class)`);
    if (result.skippedByGeometry > 0)
      tail.push(`${result.skippedByGeometry} skipped (off-image)`);
    const msg =
      tail.length > 0
        ? `${parts.join(" ")} · ${tail.join(", ")}`
        : parts.join(" ") + ".";
    showToast(msg, { variant: "success" });
  }, [
    currentAssetIdx,
    taskAssets,
    assetQ.data?.asset,
    qc,
    taskId,
    taskClassesQ.data?.allowed_class_ids,
  ]);
  useShortcutHandler("copy_from_previous_asset", () => {
    void runCopyFromPreviousAsset();
  });

  // ──────────────────────────────────────────────────────────────────
  // May 26 — "copy annotations from any asset" feature. Both the
  // right-click thumbnail menu and the Shift+P prompt funnel into the
  // same confirm dialog. The page owns dialog state; the strip only
  // emits the click position via onContextMenuCopy.
  // ──────────────────────────────────────────────────────────────────
  const [copyDialogSourceId, setCopyDialogSourceId] = useState<string | null>(
    null,
  );
  const [copyPromptOpen, setCopyPromptOpen] = useState(false);
  const [thumbMenu, setThumbMenu] = useState<{
    sourceAssetId: string;
    x: number;
    y: number;
  } | null>(null);

  // Fetch the raw annotations once the dialog opens so the breakdown
  // line lights up without an extra network round-trip on confirm.
  // Shares its queryKey with the filter-active query above; TanStack
  // dedupes the request when both subscribers want fresh data.
  // Imperative fetch driven by the dialog's open state. We deliberately
  // do NOT use ``useQuery`` here — ``refetchOnMount: "always"`` only
  // fires on observer mount (already happened at page mount), not on
  // ``enabled`` flips, so the first dialog open after a realtime
  // resync could leave isFetching=true forever (the auto-fetch gets
  // cancelled by the invalidation before it completes). Driving the
  // fetch via ``qc.fetchQuery`` in an effect makes it deterministic:
  // exactly one fetch per dialog open, deduped against any other
  // in-flight call to the same queryKey, immune to upstream
  // invalidation.
  const [breakdownRows, setBreakdownRows] = useState<
    Awaited<ReturnType<typeof annotationsApi.listForTaskRaw>> | null
  >(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  useEffect(() => {
    if (!copyDialogSourceId) {
      setBreakdownRows(null);
      setBreakdownLoading(false);
      return;
    }
    let cancelled = false;
    setBreakdownLoading(true);
    setBreakdownRows(null);
    qc.fetchQuery({
      queryKey: ["task-annotations-raw", taskId],
      queryFn: () => annotationsApi.listForTaskRaw(taskId),
    })
      .then((data) => {
        if (cancelled) return;
        setBreakdownRows(data);
        setBreakdownLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setBreakdownLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [copyDialogSourceId, qc, taskId]);

  const copyDialogBreakdown: BreakdownCounts | "loading" | null = useMemo(() => {
    if (!copyDialogSourceId) return null;
    if (breakdownLoading || !breakdownRows) return "loading";
    const rows = breakdownRows.filter(
      (r) => r.asset_id === copyDialogSourceId,
    );
    const counts = { bbox: 0, polygon: 0, tag: 0, mask: 0 };
    for (const r of rows) {
      if (r.kind === "bbox") counts.bbox += 1;
      else if (r.kind === "polygon") counts.polygon += 1;
      else if (r.kind === "tag") counts.tag += 1;
      else if (r.kind === "mask") counts.mask += 1;
    }
    return { ...counts, total: rows.length } satisfies BreakdownCounts;
  }, [copyDialogSourceId, breakdownRows, breakdownLoading]);

  // Live count of existing annotations on the current asset. We
  // CANNOT use ``Object.keys(byId).length`` directly — the store's
  // ``reset()`` preserves never-saved dirty creates across asset
  // switches (so the user doesn't lose work mid-navigation), which
  // means byId can carry leftover drafts from previously-visited
  // assets whose frameId is no longer current. Filtering by
  // ``frameId === current frame`` gives a faithful per-asset count
  // for both image and video assets, and subtracting pendingDeletes
  // reflects the user's optimistic delete state.
  const localById = useAnnotations((s) => s.byId);
  const localPendingDeletes = useAnnotations((s) => s.pendingDeletes);
  const targetExistingCount = useMemo(() => {
    if (!frameId) return 0;
    const pending = new Set(localPendingDeletes);
    let n = 0;
    for (const draft of Object.values(localById)) {
      if (draft.frameId !== frameId) continue;
      if (pending.has(draft.tempId)) continue;
      n += 1;
    }
    return n;
  }, [localById, localPendingDeletes, frameId]);

  const dialogSourceAsset = useMemo(
    () =>
      copyDialogSourceId
        ? taskAssets.find((a) => a.id === copyDialogSourceId) ?? null
        : null,
    [copyDialogSourceId, taskAssets],
  );
  const dialogSourceOrdinal = useMemo(() => {
    if (!copyDialogSourceId) return null;
    const idx = taskAssets.findIndex((a) => a.id === copyDialogSourceId);
    return idx >= 0 ? idx + 1 : null;
  }, [copyDialogSourceId, taskAssets]);

  const runCopyFromAsset = useCallback(
    async (sourceAssetId: string) => {
      const curr = assetQ.data?.asset;
      if (!curr) {
        showToast(
          "Asset metadata not loaded yet — try again in a moment.",
          { variant: "warning" },
        );
        return;
      }
      const sourceAsset = taskAssets.find((a) => a.id === sourceAssetId);
      const sourceName = sourceAsset?.original_name ?? "(unknown)";
      const allowed = taskClassesQ.data?.allowed_class_ids ?? null;
      const allowedSet = allowed ? new Set<string>(allowed) : null;
      let result;
      try {
        result = await copyAnnotationsFromAssetTo({
          sourceAssetId,
          targetAsset: curr,
          taskId,
          allowedClassIds: allowedSet,
          frameId: frameIdRef.current,
          qc,
        });
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : "Couldn't copy annotations.",
          { variant: "error" },
        );
        return;
      }
      if (result.sourceTotal === 0) {
        showToast(`No annotations on "${sourceName}".`, { variant: "info" });
        return;
      }
      if (result.accepted.length === 0) {
        if (result.skippedByClass > 0 && result.skippedByGeometry === 0) {
          showToast(
            `0 copied — all ${result.skippedByClass} annotations use classes not in this task.`,
            { variant: "warning" },
          );
        } else if (
          result.skippedByGeometry > 0 &&
          result.skippedByClass === 0
        ) {
          showToast(
            `0 copied — ${result.skippedByGeometry} annotations had geometry incompatible with this image.`,
            { variant: "warning" },
          );
        } else {
          showToast(`Nothing valid to copy from "${sourceName}".`, {
            variant: "info",
          });
        }
        return;
      }
      useAnnotations.getState().addMany(result.accepted);
      const parts: string[] = [
        `Copied ${result.accepted.length} annotation${result.accepted.length === 1 ? "" : "s"}`,
        `from "${sourceName}"`,
      ];
      const tail: string[] = [];
      if (result.skippedByClass > 0)
        tail.push(`${result.skippedByClass} skipped (class)`);
      if (result.skippedByGeometry > 0)
        tail.push(`${result.skippedByGeometry} skipped (off-image)`);
      const msg =
        tail.length > 0
          ? `${parts.join(" ")} · ${tail.join(", ")}`
          : parts.join(" ") + ".";
      showToast(msg, { variant: "success" });
    },
    [
      assetQ.data?.asset,
      taskAssets,
      taskId,
      taskClassesQ.data?.allowed_class_ids,
      qc,
    ],
  );

  useShortcutHandler("copy_from_any_asset", () => {
    setCopyPromptOpen(true);
  });

  // F2 — skip-nav to next/prev empty / unreviewed asset. The walks
  // happen against the cached task-annotations-raw query when present;
  // when the cache is cold the handlers fetch on demand so the first
  // press is a one-off network call rather than a no-op.
  const runSkipNav = useCallback(
    async (
      mode: "empty" | "unreviewed",
      direction: SkipDirection,
    ): Promise<void> => {
      if (taskAssets.length === 0) return;
      let raw;
      try {
        raw = await qc.fetchQuery({
          queryKey: ["task-annotations-raw", taskId],
          queryFn: () => annotationsApi.listForTaskRaw(taskId),
          staleTime: 0,
        });
      } catch (err) {
        showToast(
          err instanceof Error
            ? `Couldn't load annotations: ${err.message}`
            : "Couldn't load annotations.",
          { variant: "error" },
        );
        return;
      }
      const target =
        mode === "empty"
          ? findNextEmptyAsset(taskAssets, raw, currentAssetIdx, direction)
          : findNextUnreviewedAsset(taskAssets, raw, currentAssetIdx, direction);
      if (!target) {
        const label = mode === "empty" ? "empty" : "unreviewed";
        const dir = direction === "forward" ? "more" : "earlier";
        showToast(`No ${dir} ${label} assets.`, { variant: "info" });
        return;
      }
      goToAsset(target.id);
    },
    [taskAssets, currentAssetIdx, taskId, qc],
  );
  useShortcutHandler("skip_next_empty", () => {
    void runSkipNav("empty", "forward");
  });
  useShortcutHandler("skip_prev_empty", () => {
    void runSkipNav("empty", "backward");
  });
  useShortcutHandler("skip_next_unreviewed", () => {
    void runSkipNav("unreviewed", "forward");
  });
  useShortcutHandler("skip_prev_unreviewed", () => {
    void runSkipNav("unreviewed", "backward");
  });

  const confirm = useConfirm();
  const handleClearFrame = useCallback(async () => {
    const fid = frameIdRef.current;
    const all = Object.values(useAnnotations.getState().byId).filter(
      (d) => d.frameId === fid,
    );
    if (all.length === 0) {
      showToast("No annotations on this image.", { variant: "info" });
      return;
    }
    const ok = await confirm({
      title: `Clear ${all.length} annotation${all.length === 1 ? "" : "s"}?`,
      description:
        "All annotations on this image will be permanently removed. Classes are kept. Cmd+Z can restore them individually.",
      variant: "danger",
      confirmLabel: "Clear all",
    });
    if (!ok) return;
    useAnnotations.getState().removeMany(all.map((d) => d.tempId));
    showToast(
      `Cleared ${all.length} annotation${all.length === 1 ? "" : "s"}.`,
      { variant: "success" },
    );
  }, [confirm]);

  // Live polygon count on the current frame — drives the disabled state
  // + count badge on the toolbar's "Convert polygons on this image"
  // menu item. Recomputed on every store mutation so the count stays in
  // sync as the user draws / deletes polygons.
  const polygonCountOnImage = useAnnotations((s) => {
    let n = 0;
    for (const a of Object.values(s.byId)) {
      if (a.kind === "polygon" && a.frameId === frameId) n++;
    }
    return n;
  });

  const handleConvertPolygonsOnImage = useCallback(async () => {
    const fid = frameIdRef.current;
    const count = countPolygonsOnFrame(fid);
    if (count === 0) {
      showToast("No polygons on this image.", { variant: "info" });
      return;
    }
    const ok = await confirm({
      title: `Convert ${count} polygon${count === 1 ? "" : "s"} to bbox?`,
      description:
        "Polygon detail will be replaced with the enclosing axis-aligned bounding box on this image. Cmd+Z can undo individual conversions.",
      confirmLabel: "Convert",
    });
    if (!ok) return;
    bulkConvertPolygonsOnFrameToBboxWithToast(fid);
  }, [confirm]);

  // Range clear — opens the ClearRangeDialog. The dialog owns the
  // From/To pick + the scoped batch delete; the page just holds its
  // open state and feeds it the canonical asset order + dirty guard.
  const [clearRangeOpen, setClearRangeOpen] = useState(false);

  // v3.31 — task-wide clear. Mirrors handleConvertPolygonsInTask:
  // refuse when there are unsaved local drafts (the user must save or
  // discard first so we don't half-delete a session) and show a hard
  // confirm dialog with the exact count before sending a batch delete.
  const handleClearAnnotationsInTask = useCallback(async () => {
    if (dirtyCount > 0) {
      showToast(
        "Save your unsaved changes before clearing all assets.",
        { variant: "error" },
      );
      return;
    }
    let raw;
    try {
      raw = await annotationsApi.listForTaskRaw(taskId);
    } catch {
      showToast("Failed to fetch annotations.", { variant: "error" });
      return;
    }
    if (raw.length === 0) {
      showToast("No annotations to clear in this task.", { variant: "info" });
      return;
    }
    const ok = await confirm({
      title: `Clear ${raw.length} annotation${raw.length === 1 ? "" : "s"} across this task?`,
      description:
        "Every annotation (bbox, polygon, classification tag, mask) on every asset in this task will be permanently removed. Classes are kept. This affects assets that aren't currently open and cannot be undone with Cmd+Z.",
      variant: "danger",
      confirmLabel: "Clear all",
    });
    if (!ok) return;
    await bulkClearTaskAnnotationsWithToast(taskId, raw);
    qc.invalidateQueries({ queryKey: ["annotations"] });
    qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
    qc.invalidateQueries({ queryKey: ["task-annotations-raw", taskId] });
  }, [confirm, dirtyCount, qc, taskId]);

  const handleConvertPolygonsInTask = useCallback(async () => {
    if (dirtyCount > 0) {
      showToast(
        "Save your unsaved changes before converting all assets.",
        { variant: "error" },
      );
      return;
    }
    let polygons;
    try {
      const all = await annotationsApi.listForTaskRaw(taskId);
      polygons = all.filter((a) => a.kind === "polygon");
    } catch {
      showToast("Failed to fetch annotations.", { variant: "error" });
      return;
    }
    if (polygons.length === 0) {
      showToast("No polygons to convert in this task.", { variant: "info" });
      return;
    }
    const ok = await confirm({
      title: `Convert ${polygons.length} polygon${polygons.length === 1 ? "" : "s"} across this task?`,
      description:
        "Every polygon on every asset in this task will be replaced with its enclosing bounding box. This affects assets that aren't currently open and cannot be undone with Cmd+Z.",
      variant: "danger",
      confirmLabel: "Convert all",
    });
    if (!ok) return;
    await bulkConvertPolygonsInTaskToBboxWithToast(taskId, polygons);
    qc.invalidateQueries({ queryKey: ["annotations", taskId] });
  }, [confirm, dirtyCount, qc, taskId]);

  // Ctrl/Cmd+C — copy every selected bbox to the clipboard. The
  // clipboard now holds an array (state/annotations.ts), survives
  // asset switches, and pastes preserving the original group layout.
  // Other kinds (polygon, mask, tag) are intentionally filtered out
  // per the existing single-bbox UX — bboxes are by far the most
  // common case and silently dropping the rest keeps the toast count
  // honest.
  useShortcutHandler("copy", () => {
    const state = useAnnotations.getState();
    const ids =
      state.selectedIds.length > 0
        ? state.selectedIds
        : state.selectedId
          ? [state.selectedId]
          : [];
    if (ids.length === 0) return;
    const bboxIds = ids.filter((id) => state.byId[id]?.kind === "bbox");
    if (bboxIds.length === 0) return;
    state.copyToClipboard(bboxIds);
    const skipped = ids.length - bboxIds.length;
    const msg =
      bboxIds.length === 1
        ? "Bbox copied"
        : `${bboxIds.length} bboxes copied`;
    showToast(
      skipped > 0 ? `${msg} (${skipped} non-bbox skipped)` : msg,
      { variant: "info", duration: 1500 },
    );
  });

  // Editor-wide guard: any chord that the editor binds (everything in
  // ACTIONS plus any user override) must be eaten before Chrome can
  // honour its native equivalent (Cmd+D bookmark, Cmd+P print, Cmd+S
  // save-as, etc.). Individual useShortcutHandler callbacks below
  // still run normally; this listener is purely a preventDefault
  // catcher so unbound or input-targeted chords never reach the
  // browser when the user is annotating.
  const shortcutOverrides = useShortcutsQuery().data?.overrides;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        // While typing, only catch chords that include a modifier
        // (Cmd/Ctrl/Alt) — otherwise we'd swallow the user's letters.
        if (!e.metaKey && !e.ctrlKey && !e.altKey) return;
      }
      for (const id of Object.keys(ACTIONS)) {
        const override = shortcutOverrides?.[id];
        const chord =
          typeof override === "string" ? override : ACTIONS[id].default;
        if (!chord) continue;
        if (matchChord(e, chord)) {
          e.preventDefault();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutOverrides]);

  // Ctrl/Cmd+D — duplicate every selected annotation at a small offset.
  // Without an explicit handler the registered chord (`mod+d`) lets
  // Chrome's bookmark dialog open. Binding the action makes
  // useShortcutHandler call preventDefault on the keydown so the
  // browser default never runs.
  useShortcutHandler("duplicate", () => {
    const state = useAnnotations.getState();
    const ids = state.selectedIds.length > 0
      ? state.selectedIds
      : state.selectedId
        ? [state.selectedId]
        : [];
    if (ids.length === 0) return;
    const a = assetQ.data?.asset;
    const bounds =
      a && typeof a.width === "number" && typeof a.height === "number"
        ? { w: a.width, h: a.height }
        : undefined;
    for (const id of ids) {
      state.duplicate(id, 16, 16, bounds);
    }
  });

  // Ctrl/Cmd+V — CVAT-style floating paste. Instead of dropping the
  // clipboard at a fixed offset, we ARM a placement: the canvas paints
  // a translucent ghost of the copied bbox(es) that follows the cursor,
  // and a left-click commits them centred on the pointer (Esc / right-
  // click cancels). The ghost + commit share the same anchoring math so
  // what the user sees is exactly what lands. A snapshot of the clipboard
  // is handed to the tool store so a later Ctrl+C can't change what is
  // mid-placement. Commit + the success toast live in AnnotationCanvas.
  useShortcutHandler("paste", () => {
    const cb = useAnnotations.getState().clipboard;
    if (!cb || cb.length === 0) return;
    useTool.getState().startPastePlacement(cb);
    showToast(
      cb.length === 1
        ? "Click to place the copied bbox · Esc to cancel"
        : `Click to place ${cb.length} copied bboxes · Esc to cancel`,
      { variant: "info", duration: 2200 },
    );
  });

  // v3.20 -- customizable shortcuts. Every action below is editable in
  // Settings -> Shortcuts. Empty-chord overrides ("unbound") are
  // honored by useShortcutHandler -- the listener stays registered
  // but never fires.
  useShortcutHandler("undo", () => {
    useAnnotations.getState().undo();
  });
  useShortcutHandler("redo", () => {
    useAnnotations.getState().redo();
  });
  useShortcutHandler("select_all", () => {
    // Read the live frameId so select-all picks up the current asset's
    // frame, not a stale capture (frameId flips when assetQ resolves).
    useAnnotations.getState().selectAll(frameIdRef.current);
  });
  useShortcutHandler("convert_to_bbox", (e) => {
    const sel = useAnnotations.getState().selectedIds;
    if (sel.length === 0) {
      // Nothing selected -- don't preventDefault would have already
      // fired; this is a no-op fallthrough to keep `c` typeable in
      // contexts where nothing is selected.
      return;
    }
    const drafts = useAnnotations.getState().byId;
    const eligible = sel.filter((id) => {
      const d = drafts[id];
      return !!d && (d.kind === "polygon" || d.kind === "mask");
    });
    if (eligible.length === 0) return;
    e.preventDefault();
    bulkConvertSelectedToBboxWithToast(eligible);
  });
  useShortcutHandler("bring_to_front", () => {
    const sel = useAnnotations.getState().selectedId;
    if (sel) useAnnotations.getState().bringToFront(sel);
  });
  useShortcutHandler("bring_forward", () => {
    const sel = useAnnotations.getState().selectedId;
    if (sel) useAnnotations.getState().bringForward(sel);
  });
  useShortcutHandler("send_to_back", () => {
    const sel = useAnnotations.getState().selectedId;
    if (sel) useAnnotations.getState().sendToBack(sel);
  });
  useShortcutHandler("send_backward", () => {
    const sel = useAnnotations.getState().selectedId;
    if (sel) useAnnotations.getState().sendBackward(sel);
  });
  // v3.8 Phase 4-video step F8 — on video assets plain ArrowLeft/Right
  // steps frames; Shift+Arrow navigates between assets. Frame stepping
  // was previously delegated to FrameTimeline, but FrameTimeline only
  // registers the bracket / comma variants — so plain Arrow on a video
  // did nothing (the early-return swallowed it). Step frames here.
  useShortcutHandler("frame_prev", (e) => {
    if (isVideoAsset && !e.shiftKey) {
      const total = (framesQ.data ?? []).length;
      if (total <= 1) return;
      const step = Math.max(
        1, Math.round(useEditorSettings.getState().playerStep),
      );
      setCurrentFrameIdx((idx) => Math.max(0, idx - step));
      return;
    }
    const target = navAssetRef.current.prev;
    if (target) goToAsset(target.id);
  });
  useShortcutHandler("frame_next", (e) => {
    if (isVideoAsset && !e.shiftKey) {
      const total = (framesQ.data ?? []).length;
      if (total <= 1) return;
      const step = Math.max(
        1, Math.round(useEditorSettings.getState().playerStep),
      );
      setCurrentFrameIdx((idx) => Math.min(total - 1, idx + step));
      return;
    }
    const target = navAssetRef.current.next;
    if (target) goToAsset(target.id);
  });

  // Plan 14 Phase 8 Task 9 — typed editor breadcrumbs
  // ``Workspace › <Project> › <Task> › Asset N/M``
  // Wired via the new ``breadcrumbSegments`` prop on TopBar so the
  // segments use the shared <Breadcrumbs> component (Task 2) and link
  // back to each level in the navigation tree.
  const taskListQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => tasksApi.listForProject(projectId),
    staleTime: 30_000,
  });
  const currentTask = useMemo(
    () => (taskListQ.data ?? []).find((t) => t.id === taskId) ?? null,
    [taskListQ.data, taskId],
  );

  const breadcrumbSegments = useMemo(() => {
    const segments: import("@/components/nav/Breadcrumbs").BreadcrumbSegment[] = [
      { label: "Workspace", to: "/projects", testId: "editor-bc-workspace" },
    ];
    if (projectQ.data) {
      segments.push({
        label: projectQ.data.name,
        to: "/projects/$projectId",
        params: { projectId },
        testId: "editor-bc-project",
      });
    }
    if (currentTask) {
      // Tasks don't have a dedicated route at this time; link back to
      // the parent project page where the task list lives.
      segments.push({
        label: currentTask.name,
        to: "/projects/$projectId",
        params: { projectId },
        testId: "editor-bc-task",
      });
    }
    const total = (taskAssetsQ.data ?? []).length;
    const idx = (taskAssetsQ.data ?? []).findIndex((a) => a.id === assetId);
    if (total > 0 && idx >= 0) {
      segments.push({
        label: `Asset ${idx + 1}/${total}`,
        testId: "editor-bc-asset",
      });
    } else if (assetQ.data) {
      segments.push({
        label: assetQ.data.asset.original_name,
        testId: "editor-bc-asset",
      });
    }
    return segments;
  }, [projectQ.data, currentTask, taskAssetsQ.data, assetQ.data, projectId, assetId]);

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
    // v3.24.6 — unified loading surface. Same Skeleton component the
    // root auth gate and Suspense fallbacks use, so refresh shows
    // ONE typography + spinner identity across all three phases.
    return <Skeleton fullScreen label="Loading editor…" />;
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
  // v3.8 Phase 4-video — ANY video asset routes through the frames-list
  // flow, even right after upload when only the poster row exists in DB.
  // The "Extracting video frames..." overlay covers the canvas until
  // the worker fills the table; the editor never falls back to the
  // raw mp4 URL (which would just autoplay).
  const isVideo = asset.kind === "video";
  const hasError = saveMutation.isError;

  return (
    <TooltipProvider delayDuration={250}>
    <BackgroundJobsLeaveGuard taskId={taskId} />
    <div className="flex h-screen flex-col bg-[var(--bg-app)] overflow-hidden">
      <TopBar breadcrumbSegments={breadcrumbSegments} rightAction={rightAction} />

      <div className="flex flex-1 min-h-0">
        <LeftNav defaultCollapsed persist={false} />

        <div className="flex flex-1 min-w-0 flex-col">
          <EditorToolbar
            projectId={projectId}
            taskId={taskId}
            assetId={assetId}
            isVideo={isVideo}
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
            onClearFrame={handleClearFrame}
            onClearTask={handleClearAnnotationsInTask}
            onClearRange={() => setClearRangeOpen(true)}
            onConvertPolygonsOnImage={handleConvertPolygonsOnImage}
            onConvertPolygonsInTask={handleConvertPolygonsInTask}
            polygonCountOnImage={polygonCountOnImage}
            onAfterYoloPredict={() => {
              qc.invalidateQueries({ queryKey: ["annotations", taskId] });
            }}
            classes={classesQ.data ?? []}
            rightSlot={
              <SavedViewsMenu
                taskId={taskId}
                currentQuery={appliedQuery}
                activeViewId={activeViewId}
                onSelect={applySavedView}
              />
            }
          />

          <ClearRangeDialog
            open={clearRangeOpen}
            onOpenChange={setClearRangeOpen}
            taskId={taskId}
            orderedAssetIds={taskAssets.map((a) => a.id)}
            dirtyCount={dirtyCount}
            onCleared={() => {
              qc.invalidateQueries({ queryKey: ["annotations"] });
              qc.invalidateQueries({ queryKey: ["task-annotations", taskId] });
              qc.invalidateQueries({
                queryKey: ["task-annotations-raw", taskId],
              });
            }}
          />

          <SamUnavailableBanner />

          <ResumeProgressBanner
            projectId={projectId}
            taskId={taskId}
            currentAssetId={assetId}
            onResume={(targetAssetId) => goToAsset(targetAssetId)}
          />

          <ThumbnailStripGate
            taskId={taskId}
            projectId={projectId}
            activeAssetId={assetId}
            onContextMenuCopy={(sourceAssetId, pos) => {
              setThumbMenu({ sourceAssetId, x: pos.x, y: pos.y });
            }}
          />


          <div className="flex flex-1 min-h-0">
            <main
              className={cn(
                "relative flex-1 min-w-0 bg-[var(--bg-canvas)]",
                // v3.24.8 — removed the broken CSS rule
                // ``!annotationsVisible && "[&_.canvas-checker_*]:hidden"``
                // It hid EVERY descendant of ``.canvas-checker`` —
                // including the Pixi <canvas> element that renders the
                // underlying image — so toggling "Hide annotations"
                // also hid the image. The Pixi shape layer already
                // respects ``visibility.annotations`` correctly
                // (AnnotationCanvas.tsx:1103: each annotation graphic's
                // ``.visible`` is set from ``visAnn``), so the CSS
                // overlay was both redundant and incorrect.
              )}
            >
              <AnnotationCanvas
                width={w}
                height={h}
                imageUrl={(() => {
                  // v3.8 Phase 4-video step C (revised) — for video
                  // assets, currentFrameIdx is treated as a POSITION
                  // within the extracted-frames list (0..N-1), not the
                  // raw video frame index. This way scrubbing the
                  // timeline always lands on a real extracted frame
                  // even when extraction is sparse (auto strategy).
                  // We deliberately do NOT fall back to the raw mp4
                  // URL — that would let the browser play the video
                  // instead of showing a still frame. When frames are
                  // unavailable, the canvas gets an empty string and
                  // the extraction-status overlay below covers the area.
                  if (isVideo) {
                    const frames = framesQ.data ?? [];
                    const frame = frames[Math.min(currentFrameIdx, frames.length - 1)];
                    return frame?.url ?? "";
                  }
                  return url;
                })()}
                frameId={(() => {
                  if (isVideo) {
                    const frames = framesQ.data ?? [];
                    const frame = frames[Math.min(currentFrameIdx, frames.length - 1)];
                    return frame?.frame_id ?? null;
                  }
                  return frameId;
                })()}
                assetId={assetId}
                onZoomChange={setZoomPct}
                onImageStatusChange={handleImageStatusChange}
                reloadKey={imageReloadKey}
                classColorMap={classColorMap}
                classNameMap={classNameMap}
                classes={classesQ.data ?? []}
                digitToClassId={digitToClassId}
                onPointerMoveImage={handlePointerMoveImage}
                onTransformChange={setCanvasTransform}
              />
              <PresenceCursorLayer
                transform={canvasTransform}
                assetId={assetId}
              />
              <PresenceFocusLayer transform={canvasTransform} />
              <SelectionCountBadge
                // v3.27.11 — pass the LIVE active frame id so the badge
                // can split a multi-selection into "here" vs "elsewhere"
                // when the user has built it across frames. Mirrors the
                // expression used by <ClassesPanel currentFrameId>.
                frameId={
                  isVideo
                    ? ((framesQ.data ?? [])[
                        Math.min(
                          currentFrameIdx,
                          (framesQ.data?.length ?? 1) - 1,
                        )
                      ]?.frame_id ?? frameId)
                    : frameId
                }
              />
              {/* v3.8 Phase 4-video step E — extraction-status overlay
                  for video assets that don't have per-frame JPEGs yet.
                  Replaces the misleading "Failed to load image" overlay
                  that used to fire when the canvas tried to render the
                  raw mp4 URL. The Re-extract button in the toolbar lets
                  the user kick a fresh extraction; the framesQ poller
                  picks up new rows automatically every ~3s. */}
              {isVideo && (framesQ.data ?? []).length === 0 && (() => {
                // v3.8 Phase 4-video step F — live extraction progress.
                // Read the worker's Redis hash via extractStatusQ.
                const s = extractStatusQ.data;
                const phase = s?.phase ?? "idle";
                const expected = s?.expected ?? 0;
                const decoded = s?.decoded ?? 0;
                const uploaded = s?.uploaded ?? 0;
                const phaseLabel =
                  phase === "decoding"
                    ? "Decoding video…"
                    : phase === "uploading"
                      ? "Uploading frames…"
                      : phase === "done"
                        ? "Finishing up…"
                        : s?.status === "failed"
                          ? "Extraction failed"
                          : "Waiting for worker…";
                const progress =
                  expected > 0
                    ? phase === "uploading"
                      ? uploaded / expected
                      : decoded / expected
                    : 0;
                const pct = Math.min(
                  100,
                  Math.max(0, Math.round(progress * 100)),
                );
                const failed = s?.status === "failed";
                return (
                  <div
                    data-testid="extracting-frames-overlay"
                    className={cn(
                      "absolute inset-0 z-30 flex items-center justify-center",
                      "bg-[oklch(0_0_0/0.40)] backdrop-blur-[2px]",
                    )}
                  >
                    <div
                      className={cn(
                        "w-[min(92vw,460px)] rounded-[var(--radius-lg)]",
                        "glass-surface-strong p-5 grid gap-3",
                      )}
                    >
                      <div className="grid gap-1">
                        <div className="text-[14px] font-medium tracking-tight text-[color:var(--text-primary)]">
                          {failed ? "Frame extraction failed" : phaseLabel}
                        </div>
                        <p className="text-[12px] text-[color:var(--text-secondary)] leading-snug tabular-nums">
                          {failed
                            ? (s?.message ??
                                "Check worker logs and try Re-extract.")
                            : phase === "decoding"
                              ? `${decoded}${
                                  expected > 0 ? ` / ${expected}` : ""
                                } frames decoded`
                              : phase === "uploading"
                                ? `${uploaded} / ${expected} frames uploaded`
                                : "Worker is starting…"}
                        </p>
                      </div>
                      {!failed && (
                        <div className="h-2 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--accent)] transition-[width] duration-200"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                      <p className="text-[11px] text-[color:var(--text-tertiary)] italic">
                        Use the toolbar's <strong>Re-extract frames</strong>{" "}
                        button to override the strategy.
                      </p>
                    </div>
                  </div>
                );
              })()}
              {imageStatus === "error" && !(isVideo && (framesQ.data ?? []).length === 0) && (
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
              {/* Plan-15 Phase 9 follow-up — Info / Cheatsheet triggers
                  moved to the editor toolbar next to the gear. Mount
                  the cheat-sheet dialog here without its own button so
                  ``carve:open-cheat-sheet`` events still toggle it. */}
              <KeyboardCheatSheet hideTrigger />

              {/* Arbitrary-source annotation copy — May 26 */}
              {thumbMenu && (
                <ThumbContextMenu
                  open
                  x={thumbMenu.x}
                  y={thumbMenu.y}
                  onClose={() => setThumbMenu(null)}
                  onCopy={() => {
                    setCopyDialogSourceId(thumbMenu.sourceAssetId);
                    setThumbMenu(null);
                  }}
                />
              )}

              <CopyFromPromptDialog
                open={copyPromptOpen}
                onOpenChange={setCopyPromptOpen}
                totalAssets={taskAssets.length}
                currentOrdinal={currentAssetIdx + 1}
                onPick={(ordinal) => {
                  const picked = taskAssets[ordinal - 1];
                  setCopyPromptOpen(false);
                  if (picked) {
                    setCopyDialogSourceId(picked.id);
                  }
                }}
              />

              <CopyAnnotationsDialog
                open={copyDialogSourceId !== null}
                onOpenChange={(o) => {
                  if (!o) setCopyDialogSourceId(null);
                }}
                sourceAsset={dialogSourceAsset}
                sourceOrdinal={dialogSourceOrdinal}
                totalAssets={taskAssets.length}
                targetAsset={assetQ.data?.asset ?? null}
                targetExistingCount={targetExistingCount}
                breakdown={copyDialogBreakdown}
                onConfirm={async () => {
                  if (!copyDialogSourceId) return;
                  const sourceId = copyDialogSourceId;
                  setCopyDialogSourceId(null);
                  await runCopyFromAsset(sourceId);
                }}
              />
              {/* v3.27.9 — fixed progress chip that survives tool
                  switches. <SamTrackModeGate> below only mounts the
                  full TrackPanel while SAM Track is active; this badge
                  reads useTrackBridge directly so the user sees the
                  propagation tick even after switching to Drag/Bbox/etc. */}
              <TrackProgressBadge />
              {/* Bug-fix May 26 — asset-switch loading indicator. The
                  ``placeholderData: prev => prev`` on ``assetQ`` keeps
                  the previously-loaded asset on screen while the next
                  one fetches, which avoids the disorienting "flash to
                  Loading…" screen on every navigation but historically
                  meant the user had no visible signal that their
                  thumbnail click did anything. The chip below appears
                  only while the route's ``assetId`` differs from the
                  asset currently rendered, so it matches the "click
                  registered, switch in flight" window exactly and
                  disappears the moment the new asset paints. */}
              {assetQ.data && assetQ.data.asset.id !== assetId && (
                <div
                  data-testid="asset-switch-loading-overlay"
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-4 z-30",
                    "flex justify-center",
                  )}
                  aria-hidden
                >
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 px-3 py-1.5",
                      "rounded-full text-[12px] font-medium",
                      "bg-[var(--bg-elev)]/95 backdrop-blur-sm",
                      "border border-[var(--border-subtle)] shadow",
                      "text-[color:var(--text-secondary)]",
                    )}
                  >
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden
                    />
                    Loading asset…
                  </span>
                </div>
              )}
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
              <Tabs
                defaultValue="classes"
                variant="segment"
                className="relative flex-1 min-h-0 flex flex-col"
              >
                {/* v3.24.7 — redesigned tab bar:
                    - icon + label triggers (visual differentiation)
                    - flex stretch so tabs share the width evenly
                    - h-9 hit target (was h-7 — too small to tap reliably)
                    - 3-up grid keeps the labels honest (no truncation) */}
                <Tabs.List
                  aria-label="Side panel"
                  className="mx-2 mt-2 grid grid-cols-3 gap-1"
                >
                  <Tabs.Trigger
                    value="classes"
                    className="h-9 justify-center"
                  >
                    <Tag className="h-3.5 w-3.5" />
                    Classes
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="objects"
                    className="h-9 justify-center"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    Objects
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="review"
                    className="h-9 justify-center"
                  >
                    <CheckSquare className="h-3.5 w-3.5" />
                    Review
                  </Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content
                  value="classes"
                  className="flex-1 min-h-0 overflow-hidden focus-visible:outline-none"
                >
                  <ClassesPanel
                    classes={classesQ.data ?? []}
                    // v3.27.7 — pass the LIVE active frame id (not the
                    // asset's primary_frame_id from assetQ, which never
                    // changes when the user navigates the timeline).
                    // For image assets there is only one frame so the
                    // primary frame id IS the active frame id.
                    currentFrameId={
                      isVideo
                        ? ((framesQ.data ?? [])[
                            Math.min(
                              currentFrameIdx,
                              (framesQ.data?.length ?? 1) - 1,
                            )
                          ]?.frame_id ?? frameId)
                        : frameId
                    }
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
                    digitToClassId={digitToClassId}
                  />
                </Tabs.Content>
                <Tabs.Content
                  value="objects"
                  className="flex-1 overflow-y-auto p-3 focus-visible:outline-none"
                >
                  <ObjectsPanel frameId={frameId} classes={classByIdMap} />
                  {/* F3 — annotation health flags. Renders below the
                      object list so the user has the count + drill-in
                      to suspicious annotations in their primary work
                      tab. Pure detectors against the local store; no
                      backend cost. */}
                  <div className="mt-3">
                    <HealthPanel
                      frameId={frameId}
                      imageSize={
                        typeof assetQ.data?.asset?.width === "number" &&
                        typeof assetQ.data?.asset?.height === "number"
                          ? { w: assetQ.data.asset.width, h: assetQ.data.asset.height }
                          : null
                      }
                    />
                  </div>
                </Tabs.Content>
                <Tabs.Content
                  value="review"
                  className="flex-1 overflow-y-auto focus-visible:outline-none"
                >
                  <ReviewPanel
                    classes={classesQ.data ?? []}
                    resolveReviewerName={resolveReviewerName}
                  />
                </Tabs.Content>
              </Tabs>

              {/* v3.24.7 — redesigned footer toolbar.
                  Replaces the always-visible AppearancePanel with a
                  compact icon row: Appearance popover, show/hide-all
                  toggle, plus a live status string ("N objects · M
                  selected") on the right. Frees up the vertical space
                  the disclosure used to eat and gives the user one
                  obvious place to find "render settings" and quick
                  visibility toggles. */}
              <RightRailFooter />
              {/* Legacy appearance disclosure left in place for the
                  rare case where the popover isn't sufficient — but
                  hidden via display:none so it doesn't render twice.
                  Kept as a render-side fallback only; remove when
                  every existing test that touches
                  ``data-testid=appearance-panel-toggle`` is updated. */}
              <div className="hidden">
                <AppearancePanel />
              </div>
              {/* v3.5 Phase E — SAM video tracking panel. Renders below
                  the tabs (i.e. doesn't replace the existing right rail)
                  when the user is in SAM Track mode on a video asset.
                  Keeps Phase D's other modes' UX untouched. */}
              <SamTrackModeGate
                assetId={assetId}
                frameId={
                  // Pass the actual frame_id at the active position so
                  // the panel's commit map seeds correctly.
                  isVideo
                    ? ((framesQ.data ?? [])[
                        Math.min(currentFrameIdx, (framesQ.data ?? []).length - 1)
                      ]?.frame_id ?? frameId)
                    : frameId
                }
                // v3.27.6 — SAM 3.1 multiplex iterates the cached JPEG
                // sequence and emits POSITIONAL frame indices (0..N-1),
                // matching ``frameIdxToFrameId`` (also keyed by list
                // position). The earlier code converted to raw
                // ``frame.idx`` (0,5,10,…) here on the way IN to the
                // tool, breaking the seed-frame the model received and
                // the per-frame remove lookup. Pass the positional id
                // through unchanged.
                currentFrameIdx={currentFrameIdx}
                totalFrames={asset.frames}
                isVideo={isVideo}
                frameIdxToFrameId={frameIdxToFrameId}
                classes={classesQ.data ?? []}
              />
            </aside>
          </div>

          {isVideo && (
            <FrameTimeline
              // v3.8 Phase 4-video step C — index by EXTRACTED frame
              // count, not the raw mp4 frame count. This makes the
              // timeline a discrete walk through what's actually
              // available (matters when auto strategy downsamples).
              totalFrames={(framesQ.data ?? []).length || asset.frames}
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

      <Dialog
        open={exitPrompt !== null}
        onOpenChange={(o) => {
          // Only honour close via the X / overlay click when no save is
          // in flight; treat it the same as Cancel.
          if (!o && !exitSaving) {
            void handleExitPrompt("cancel");
          }
        }}
      >
        <DialogContent className="w-[min(92vw,480px)]">
          <DialogHeader>
            <DialogTitle>
              {trackRunning && dirtyCount === 0
                ? "Tracking is in progress"
                : trackRunning
                  ? "Tracking is in progress — and you have unsaved annotations"
                  : "Unsaved annotations"}
            </DialogTitle>
            <DialogDescription>
              {trackRunning && (
                <span className="block mb-2">
                  Run-full-track is still propagating across this
                  window. Leaving now will stop the propagation — any
                  frames not yet reached will be skipped. Already-tracked
                  polygons stay saved on the asset.
                </span>
              )}
              {dirtyCount > 0 && (
                <span className="block">
                  You have {dirtyCount} unsaved annotation
                  {dirtyCount === 1 ? "" : "s"} that won&apos;t be sent
                  to the server if you leave now.
                </span>
              )}
              <span className="block mt-2">What would you like to do?</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2 sm:flex-nowrap">
            <Button
              variant="ghost"
              onClick={() => void handleExitPrompt("cancel")}
              disabled={exitSaving}
              data-testid="exit-cancel"
            >
              {trackRunning ? "Keep tracking" : "Cancel"}
            </Button>
            {dirtyCount > 0 && (
              <Button
                variant="danger"
                onClick={() => void handleExitPrompt("discard")}
                disabled={exitSaving}
                data-testid="exit-discard"
              >
                Discard and exit
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void handleExitPrompt("save")}
              loading={exitSaving}
              data-testid="exit-save"
            >
              {dirtyCount > 0
                ? (trackRunning ? "Save, stop and exit" : "Save and exit")
                : "Stop tracking and exit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        task={currentTask}
        asset={assetQ.data}
        totalAssets={taskAssets.length}
        classes={classesQ.data ?? []}
        assigneeEmail={useAuth.getState().user?.email ?? null}
        taskId={taskId}
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
            <Input
              type="text"
              autoFocus
              data-testid="rename-class-input"
              aria-label="Class name"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
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
 * v3.24.7 — Compact footer toolbar at the bottom of the right rail.
 * Replaces the always-visible AppearancePanel disclosure with three
 * affordances:
 *
 *   1. A "show / hide all" eye toggle (flips ``visibility.shapes`` —
 *      one-click way to peek the underlying image without zooming).
 *   2. An "Appearance" popover trigger (palette icon) — opens the
 *      existing AppearancePanel content in a focused popover so its
 *      ~150 px of controls don't eat right-rail vertical space when
 *      the user isn't actively tuning rendering.
 *   3. A live status string on the right ("N objects · M selected") —
 *      gives the user a glanceable sense of frame state without
 *      switching to the Objects tab.
 *
 * Designed as a flat icon row at h-9 so it reads as a chrome strip
 * (not as content). Kept inside this file because it's tightly bound
 * to the rail's layout — extracting it to its own module would force
 * an awkward prop interface for store selectors that already live
 * here.
 */
function RightRailFooter() {
  const byId = useAnnotations((s) => s.byId);
  const selectedIds = useAnnotations((s) => s.selectedIds);
  const visibility = useTool((s) => s.visibility);
  const setVisibility = useTool((s) => s.setVisibility);
  const totalCount = Object.keys(byId).length;
  const selectedCount = selectedIds.length;
  const shapesVisible = visibility.annotations;

  return (
    <div
      role="toolbar"
      aria-label="Right rail toolbar"
      data-testid="right-rail-footer"
      className={cn(
        "flex items-center gap-1 px-2 py-1.5 h-9",
        "border-t border-[var(--glass-border)]",
        "bg-transparent",
      )}
    >
      {/* Show / hide all annotations. Eye/EyeOff swap on toggle so
          the icon itself communicates state. */}
      <Tooltip
        content={shapesVisible ? "Hide all annotations" : "Show all annotations"}
      >
        <button
          type="button"
          aria-label={shapesVisible ? "Hide all annotations" : "Show all annotations"}
          aria-pressed={!shapesVisible}
          data-testid="right-rail-toggle-shapes"
          onClick={() => setVisibility("annotations", !shapesVisible)}
          className={cn(
            "h-7 w-7 grid place-items-center rounded-[var(--radius-sm)]",
            "text-[color:var(--text-secondary)]",
            "transition-colors duration-[140ms] ease-out",
            "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
            !shapesVisible && "text-[color:var(--accent)]",
          )}
        >
          {shapesVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      </Tooltip>

      {/* Appearance popover — same controls as the legacy disclosure,
          rendered in compact mode so the popover provides chrome. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Appearance settings"
            data-testid="right-rail-appearance-trigger"
            className={cn(
              "h-7 w-7 grid place-items-center rounded-[var(--radius-sm)]",
              "text-[color:var(--text-secondary)]",
              "transition-colors duration-[140ms] ease-out",
              "hover:bg-[var(--bg-hover)] hover:text-[color:var(--text-primary)]",
              "data-[state=open]:bg-[var(--bg-subtle)] data-[state=open]:text-[color:var(--accent)]",
            )}
          >
            <Sliders className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="p-0 max-w-[280px]"
        >
          <AppearancePanel compact />
        </PopoverContent>
      </Popover>

      {/* Phase 6 — presence chips. Phase 7 — connection status sits
          on the left of the chips so the user sees a degraded WS
          state next to the avatars (the natural place to look for
          "who's here"). Both components return null in their
          happy-path states so the bar stays clean during normal use. */}
      <div className="ml-auto flex items-center gap-3">
        <PresenceConnectionStatus />
        <PresenceChips />
        {/* Live status on the right — frame's annotation count + how
            many are currently selected. Updates reactively. */}
        <span
          data-testid="right-rail-status"
          className="text-[10.5px] text-[color:var(--text-tertiary)] font-mono tabular-nums whitespace-nowrap"
        >
          {totalCount} object{totalCount === 1 ? "" : "s"}
          {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
        </span>
      </div>
    </div>
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

  const STEP = 10;
  const firstAsset = taskAssets.length > 0 ? taskAssets[0] : null;
  const lastAsset = taskAssets.length > 0 ? taskAssets[taskAssets.length - 1] : null;
  const stepBackAsset =
    currentAssetIdx > 0
      ? taskAssets[Math.max(0, currentAssetIdx - STEP)]
      : null;
  const stepForwardAsset =
    currentAssetIdx >= 0 && currentAssetIdx < taskAssets.length - 1
      ? taskAssets[Math.min(taskAssets.length - 1, currentAssetIdx + STEP)]
      : null;
  const canGoFirst = !!firstAsset && currentAssetIdx > 0;
  const canGoLast = !!lastAsset && currentAssetIdx >= 0 && currentAssetIdx < taskAssets.length - 1;

  return (
    <div data-testid="asset-nav-buttons" className="flex items-center gap-1 mr-2">
      <IconButton
        aria-label="First asset"
        size="sm"
        variant="glass"
        disabled={!canGoFirst}
        onClick={() => firstAsset && onGoTo(firstAsset.id)}
      >
        <SkipBack className="h-4 w-4" />
      </IconButton>
      <IconButton
        aria-label={`Back ${STEP} assets`}
        size="sm"
        variant="glass"
        disabled={!stepBackAsset || stepBackAsset.id === taskAssets[currentAssetIdx]?.id}
        onClick={() => stepBackAsset && onGoTo(stepBackAsset.id)}
      >
        <ChevronsLeft className="h-4 w-4" />
      </IconButton>
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
        <Input
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
      <IconButton
        aria-label={`Forward ${STEP} assets`}
        size="sm"
        variant="glass"
        disabled={!stepForwardAsset || stepForwardAsset.id === taskAssets[currentAssetIdx]?.id}
        onClick={() => stepForwardAsset && onGoTo(stepForwardAsset.id)}
      >
        <ChevronsRight className="h-4 w-4" />
      </IconButton>
      <IconButton
        aria-label="Last asset"
        size="sm"
        variant="glass"
        disabled={!canGoLast}
        onClick={() => lastAsset && onGoTo(lastAsset.id)}
      >
        <SkipForward className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

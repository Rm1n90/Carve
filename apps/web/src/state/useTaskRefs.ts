// Armin Mehri — mehri.armin@gmail.com
/**
 * useTaskRefs — shared task-scoped refs source for visual-prompt pickers.
 *
 * Returns the list of pickable image assets in the current task plus a
 * map of (asset_id → ref list). Used by both YoloeDialog (Smart Find)
 * and AutoAnnotateDialog (SAM Visual Prompt tab).
 *
 * Gated by ``enabled`` so the queries only fire when the picker is
 * visible.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { assetsApi, type Asset } from "@/api/assets";
import { annotationsApi } from "@/api/annotations";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";

interface RawRef {
  id: string;
  classId: string;
  kind: "bbox" | "polygon";
  geometry: Record<string, unknown>;
}

export interface UseTaskRefsResult {
  pickableAssets: Asset[];
  annotationsByAssetId: Map<string, RawRef[]>;
  annotationsById: Record<string, AnnotationDraft>;
  isLoading: boolean;
}

export function useTaskRefs(opts: {
  taskId?: string;
  assetId: string | null;
  enabled?: boolean;
}): UseTaskRefsResult {
  const enabled = opts.enabled !== false && !!opts.taskId;
  const taskAssetsQ = useQuery({
    queryKey: ["task-refs-assets", opts.taskId],
    queryFn: () => assetsApi.listForTask(opts.taskId!),
    enabled,
    staleTime: 30_000,
  });
  const taskAnnotationsQ = useQuery({
    queryKey: ["task-refs-annotations", opts.taskId],
    queryFn: () => annotationsApi.listForTaskRaw(opts.taskId!),
    enabled,
    staleTime: 5_000,
  });
  const annotationsByAssetId = useMemo(() => {
    const m = new Map<string, RawRef[]>();
    for (const a of taskAnnotationsQ.data ?? []) {
      if (!a.asset_id) continue;
      if (a.kind !== "bbox" && a.kind !== "polygon") continue;
      const arr = m.get(a.asset_id) ?? [];
      arr.push({
        id: a.id,
        classId: a.class_id,
        kind: a.kind as "bbox" | "polygon",
        geometry: a.geometry,
      });
      m.set(a.asset_id, arr);
    }
    return m;
  }, [taskAnnotationsQ.data]);
  const pickableAssets = useMemo<Asset[]>(() => {
    const all = taskAssetsQ.data ?? [];
    return all.filter(
      (a) =>
        a.kind === "image" &&
        ((annotationsByAssetId.get(a.id)?.length ?? 0) > 0 ||
          a.id === opts.assetId),
    );
  }, [taskAssetsQ.data, annotationsByAssetId, opts.assetId]);
  const annotationsById = useAnnotations((s) => s.byId);
  return {
    pickableAssets,
    annotationsByAssetId,
    annotationsById,
    isLoading: taskAssetsQ.isLoading || taskAnnotationsQ.isLoading,
  };
}

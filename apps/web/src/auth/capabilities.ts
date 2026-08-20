// Armin Mehri — mehri.armin@gmail.com
/**
 * Outsourcing hardening — the client-side mirror of
 * ``carve_api.permissions``.
 *
 * Carve is used to outsource annotation work: a workspace `member` is
 * given access to specific projects and is expected to annotate and
 * nothing else. Two families of capability are withheld from every
 * non-admin:
 *
 *  - **data movement** — export, upload, import, duplicate, copy. Never
 *    available to a non-admin.
 *  - **GPU / model tools** — My Model, Auto-Annotate, Smart Find, SAM,
 *    tracking, weights, device + model switching. Withheld by default;
 *    a workspace admin can re-open them for one task by setting that
 *    task's ``gpu_access_for_members``.
 *
 * These helpers exist to keep restricted controls out of the UI so a
 * member is never shown a button that will 403. They are NOT the
 * security boundary — the API enforces the same rules on every route,
 * so a hand-crafted request gets the same refusal a hidden button would
 * have produced.
 */
import { useAuth } from "./store";

export interface Capabilities {
  /** Workspace admin — unrestricted. */
  isAdmin: boolean;
  /** Export a dataset in any format. */
  canExport: boolean;
  /** Upload assets or weights, import annotations, extract video frames. */
  canUpload: boolean;
  /** Duplicate a task or bulk-copy classes between projects. */
  canDuplicate: boolean;
  /** Upload/delete/rename weights, pin defaults, switch device or SAM variant. */
  canManageModels: boolean;
}

/**
 * Workspace-level capabilities. Everything except the GPU tools is
 * decided by role alone — GPU access is per task, see
 * {@link useTaskCapabilities}.
 */
export function useCapabilities(): Capabilities {
  const role = useAuth((s) => s.user?.role ?? null);
  const isAdmin = role === "admin";
  return {
    isAdmin,
    canExport: isAdmin,
    canUpload: isAdmin,
    canDuplicate: isAdmin,
    canManageModels: isAdmin,
  };
}

/**
 * Whether the GPU/model tools should be offered for one specific task.
 *
 * Admins always get them. A member gets them only when an admin has
 * granted that task. Pass ``undefined`` while the task is still loading
 * — a member then gets ``false``, so the AI toolbar never flashes into
 * view before the grant is known.
 */
export function useTaskGpuAccess(
  task: { gpu_access_for_members?: boolean } | null | undefined,
): boolean {
  const role = useAuth((s) => s.user?.role ?? null);
  if (role === "admin") return true;
  return task?.gpu_access_for_members === true;
}

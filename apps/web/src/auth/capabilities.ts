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
  /**
   * Carries workspace-admin authority. TRUE for superadmins too — the
   * tier above admin must never render as having fewer powers. Always
   * branch on this rather than comparing the role to "admin".
   */
  isAdmin: boolean;
  /**
   * The top tier only. Gates the account controls admins deliberately
   * do not get: managing admin accounts, resetting someone else's
   * password, blocking, force-logout, purging the trash, suspending a
   * project.
   */
  isSuperAdmin: boolean;
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
  const isSuperAdmin = role === "superadmin";
  const isAdmin = isSuperAdmin || role === "admin";
  return {
    isAdmin,
    isSuperAdmin,
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
  if (role === "admin" || role === "superadmin") return true;
  return task?.gpu_access_for_members === true;
}

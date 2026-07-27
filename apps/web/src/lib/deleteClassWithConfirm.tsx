// Armin Mehri — mehri.armin@gmail.com
/**
 * Shared, count-accurate class-deletion flow.
 *
 * Post-incident guard: deleting a class cascade-deletes every annotation
 * that referenced it, irreversibly (no soft-delete / undo). A single
 * mistaken click once discarded ~37K annotations because the confirm
 * dialog only said "permanently deleted" without ever showing HOW MANY.
 *
 * This helper closes that gap. It runs a *guarded* delete first
 * (`force` omitted): the server refuses a non-empty class with a 409
 * `class_has_annotations` and returns the exact annotation count, or
 * deletes immediately when the class is empty (nothing at stake). For a
 * non-empty class we then show a danger dialog that names the real count
 * and — above a threshold — requires the user to type that number before
 * the irreversible `force=true` delete proceeds.
 *
 * Callers own the first "Delete class?" confirmation and the post-delete
 * cache invalidation / toast; this helper owns only the count-aware
 * escalation so both the project-settings and in-editor delete paths stay
 * in lock-step.
 */
import { classesApi } from "@/api/classes";
import type { ConfirmFn } from "@/components/ui/ConfirmDialog";

// At or above this many annotations, require type-to-confirm. Below it,
// the count in the button label + danger styling is friction enough.
const TYPE_TO_CONFIRM_THRESHOLD = 1000;

interface AxiosLikeError {
  response?: {
    status?: number;
    // The API's dict-detail error handler returns the body as-is, keyed
    // on `error` (see main.py `_http_error`).
    data?: { error?: string; annotation_count?: number };
  };
}

export interface DeleteClassResult {
  deleted: boolean;
  annotationsDeleted: number;
}

/**
 * Delete a class, warning proportionally about annotation loss.
 *
 * Resolves `{ deleted: false }` if the user backs out of the escalation
 * dialog. Re-throws any error that is not the expected 409 guard so the
 * caller can surface a failure toast.
 */
export async function deleteClassWithConfirm(opts: {
  projectId: string;
  classId: string;
  className: string;
  confirm: ConfirmFn;
}): Promise<DeleteClassResult> {
  const { projectId, classId, className, confirm } = opts;

  try {
    // Guarded probe — no-op that reports the count when non-empty, or a
    // real delete when the class has zero annotations.
    await classesApi.delete(projectId, classId);
    return { deleted: true, annotationsDeleted: 0 };
  } catch (err) {
    const resp = (err as AxiosLikeError).response;
    if (
      resp?.status !== 409 ||
      resp.data?.error !== "class_has_annotations"
    ) {
      throw err;
    }

    const n = resp.data.annotation_count ?? 0;
    const pretty = n.toLocaleString();
    const noun = `annotation${n === 1 ? "" : "s"}`;

    const ok = await confirm({
      title: `Permanently delete ${pretty} ${noun}?`,
      description: (
        <>
          Deleting the class{" "}
          <span className="font-medium text-[color:var(--text-primary)]">
            {className}
          </span>{" "}
          will also{" "}
          <span className="font-medium text-[color:var(--danger)]">
            permanently delete {pretty} {noun}
          </span>{" "}
          that use it, across the entire project. This cannot be undone —
          there is no backup or trash for annotations.
        </>
      ),
      variant: "danger",
      confirmLabel: `Delete ${pretty} ${noun}`,
      requireText: n >= TYPE_TO_CONFIRM_THRESHOLD ? String(n) : undefined,
    });

    if (!ok) return { deleted: false, annotationsDeleted: 0 };

    await classesApi.delete(projectId, classId, { force: true });
    return { deleted: true, annotationsDeleted: n };
  }
}

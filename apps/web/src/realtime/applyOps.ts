// Armin Mehri — mehri.armin@gmail.com
/**
 * Apply realtime ``ops:*`` envelopes to the local ``useAnnotations``
 * store, and surface a ``resync`` by invalidating the annotation
 * react-query caches so :class:`AnnotateAssetPage` refetches a
 * canonical snapshot.
 *
 * Phase 4 sits between the transport (``ws.ts``) and the existing
 * store + react-query plumbing. Two design choices worth pinning:
 *
 *   * Lookup by ``server.id``. After a local optimistic insert the
 *     draft's ``tempId`` is the client-generated id, but
 *     ``markPersisted`` sets ``serverId`` to the server-issued id —
 *     which is what the bus broadcasts. Matching by either
 *     ``serverId`` *or* ``tempId`` covers both the optimistic-
 *     before-persist edge and any future code that uses the
 *     server id as a temp id.
 *
 *   * No-op deletes are safe. ``ops:delete`` for an annotation we've
 *     already removed locally (e.g. the originating tab) just finds
 *     no row and returns — matching the REST DELETE's idempotent
 *     contract.
 *
 * Echo suppression: the *server* already drops the echo back to the
 * originating WS via ``origin_session``. Phase 4's job is only to
 * apply the cross-tab events that DO arrive. Re-applying our own
 * mutation (in the rare case the server didn't suppress — e.g. the
 * REST call happened on a connection that had since reconnected
 * with a fresh session id) is idempotent: the new state matches the
 * already-applied state.
 */

import type { QueryClient } from "@tanstack/react-query";

import { toDraft } from "@/api/annotations";
import type {
  ServerOpsBatch,
  ServerOpsDelete,
  ServerOpsUpsert,
  ServerResync,
} from "@/realtime/types";
import { useAnnotations, type AnnotationDraft } from "@/state/annotations";

/** The server-side shape consumed by ``toDraft``. ``api/annotations``
 *  defines an internal ``AnnotationOut`` interface that isn't exported,
 *  so we derive it from the function signature — guarantees this stays
 *  in sync if the REST schema changes. */
type AnnotationOut = Parameters<typeof toDraft>[0];

// -------- store accessors ----------------------------------------------------

function findExistingByServerId(serverId: string): AnnotationDraft | undefined {
  // Look up directly off the store snapshot — calling getState on every
  // event is cheap, and the alternative (subscribing) doesn't compose
  // well with a non-React caller.
  const byId = useAnnotations.getState().byId;
  for (const draft of Object.values(byId)) {
    if (draft.serverId === serverId || draft.tempId === serverId) {
      return draft;
    }
  }
  return undefined;
}

// -------- low-level apply primitives ----------------------------------------

function applyUpsert(server: AnnotationOut): void {
  // ``toDraft`` already seeds ``dirty: false`` because the data is
  // server-authoritative. We bypass the store's ``add`` / ``update``
  // actions and write via ``setState`` directly for two reasons:
  //
  //   * ``update`` forces ``dirty: true`` (its local-edit semantic),
  //     which would loop the row back through the next autosave
  //     batch — a pointless echo to the server.
  //   * ``add`` flips ``selectedId`` to the new draft's id, which
  //     would yank focus away from the local user every time a
  //     remote teammate added an annotation.
  //
  // Direct ``setState`` also skips the undo-history push, which is
  // the right call: a remote teammate's edit shouldn't pollute this
  // user's undo stack.
  const draft = toDraft(server);
  const existing = findExistingByServerId(server.id);
  useAnnotations.setState((s) => {
    if (existing) {
      return {
        byId: {
          ...s.byId,
          // Keep the local tempId stable so selection / hover state
          // tracking it doesn't blink.
          [existing.tempId]: { ...draft, tempId: existing.tempId },
        },
      };
    }
    return {
      byId: { ...s.byId, [draft.tempId]: draft },
    };
  });
}

function applyDelete(annotationId: string): void {
  const existing = findExistingByServerId(annotationId);
  if (!existing) {
    // Already gone locally (optimistic delete, or never received).
    // Match the server's idempotent REST contract — no-op.
    return;
  }
  // Direct ``setState`` (rather than ``store.remove``) skips the
  // history push and the ``pendingDeletes`` queue write — a remote
  // delete shouldn't add to this client's "things I need to delete
  // on the next save" list.
  useAnnotations.setState((s) => {
    const { [existing.tempId]: _drop, ...rest } = s.byId;
    void _drop;
    return {
      byId: rest,
      selectedId: s.selectedId === existing.tempId ? null : s.selectedId,
      selectedIds: s.selectedIds.filter((x) => x !== existing.tempId),
    };
  });
}

// -------- public entry points -----------------------------------------------

/**
 * Apply one ops envelope. ``ServerOpsBatch`` entries are applied in
 * order — the server publishes them in transaction order, and
 * client-side application must preserve that so a sequence like
 * ``[upsert A, delete A]`` ends with A removed.
 */
export function handleOpsMessage(
  msg: ServerOpsUpsert | ServerOpsDelete | ServerOpsBatch,
): void {
  if (msg.type === "ops:upsert") {
    applyUpsert(msg.annotation as unknown as AnnotationOut);
    return;
  }
  if (msg.type === "ops:delete") {
    applyDelete(msg.annotation_id);
    return;
  }
  // ``ops:batch`` — each entry is a mini-message that the server
  // built via realtime.events.make_upsert_op / make_delete_op.
  for (const op of msg.ops) {
    if (op.type === "ops:upsert" && op.annotation) {
      applyUpsert(op.annotation as unknown as AnnotationOut);
    } else if (op.type === "ops:delete" && op.annotation_id) {
      applyDelete(op.annotation_id);
    }
  }
}

/**
 * Apply a ``resync`` envelope by invalidating the annotation
 * react-queries for the current task. The page's existing effect
 * (``useAnnotations.getState().reset(annotationsQ.data)``) will pick
 * up the refetched data and replace the local store atomically.
 *
 * We invalidate both keys ``AnnotateAssetPage`` uses:
 *
 *   * ``["annotations", taskId, frameId]`` — the current-frame query
 *     that hydrates the canvas.
 *   * ``["task-annotations-raw", taskId]`` — the task-wide listing
 *     used for skip-nav and QA summaries.
 *
 * The ``queryKey`` prefix-match semantics of ``invalidateQueries``
 * mean both calls match all currently-cached frame variants.
 */
export function handleResyncMessage(
  queryClient: QueryClient,
  taskId: string,
  _msg: ServerResync,
): void {
  void queryClient.invalidateQueries({ queryKey: ["annotations", taskId] });
  void queryClient.invalidateQueries({
    queryKey: ["task-annotations-raw", taskId],
  });
}

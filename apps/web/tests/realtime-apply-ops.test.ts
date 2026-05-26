// Armin Mehri — mehri.armin@gmail.com
/**
 * Tests for ``realtime/applyOps`` — the layer that turns an inbound
 * WS envelope into a mutation on the local ``useAnnotations`` store
 * and surfaces a ``resync`` by invalidating react-query.
 *
 * No network: we drive ``handleOpsMessage`` / ``handleResyncMessage``
 * directly with synthetic envelopes. The store is the real Zustand
 * instance — that's the integration point we want to pin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleOpsMessage, handleResyncMessage } from "@/realtime/applyOps";
import { PROTOCOL_VERSION } from "@/realtime/types";
import { useAnnotations } from "@/state/annotations";
import type {
  ServerOpsBatch,
  ServerOpsDelete,
  ServerOpsUpsert,
  ServerResync,
} from "@/realtime/types";

// -------- helpers -----------------------------------------------------------

function serverAnnotation(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    class_id: "44444444-4444-4444-4444-444444444444",
    kind: "bbox",
    geometry: { kind: "bbox", x: 1, y: 2, w: 3, h: 4 },
    frame_id: "55555555-5555-5555-5555-555555555555",
    z_order: 0,
    status: "proposed",
    reviewed_by_id: null,
    reviewed_at: null,
    prev_geometry: null,
    ...overrides,
  };
}

function upsertMsg(id: string, geometry?: Record<string, unknown>): ServerOpsUpsert {
  return {
    v: PROTOCOL_VERSION,
    type: "ops:upsert",
    seq: 1,
    ts: 1,
    annotation: serverAnnotation(id, geometry ? { geometry } : {}),
    actor_id: "66666666-6666-6666-6666-666666666666",
    origin_session: null,
  };
}

function deleteMsg(id: string): ServerOpsDelete {
  return {
    v: PROTOCOL_VERSION,
    type: "ops:delete",
    seq: 2,
    ts: 2,
    annotation_id: id,
    actor_id: "66666666-6666-6666-6666-666666666666",
    origin_session: null,
  };
}

function batchMsg(ops: ServerOpsBatch["ops"]): ServerOpsBatch {
  return {
    v: PROTOCOL_VERSION,
    type: "ops:batch",
    seq: 3,
    ts: 3,
    ops,
    actor_id: "66666666-6666-6666-6666-666666666666",
    origin_session: null,
  };
}

function listLocal() {
  return Object.values(useAnnotations.getState().byId);
}

beforeEach(() => {
  // Drop every local draft so each test starts with an empty store.
  useAnnotations.getState().reset([]);
});

// -------- ops:upsert --------------------------------------------------------

describe("handleOpsMessage — ops:upsert", () => {
  it("adds an annotation when none exists locally", () => {
    handleOpsMessage(upsertMsg("aaa11111-1111-1111-1111-111111111111"));
    const local = listLocal();
    expect(local).toHaveLength(1);
    expect(local[0]?.serverId).toBe("aaa11111-1111-1111-1111-111111111111");
    expect(local[0]?.dirty).toBe(false); // server-authoritative
  });

  it("patches the existing draft in place (keeps tempId stable)", () => {
    // Seed a local draft that has already been persisted (markPersisted
    // path): tempId is the original client id, serverId is the
    // server-issued id that the bus broadcasts.
    const localTempId = "local-temp-id";
    const serverId = "bbb22222-2222-2222-2222-222222222222";
    useAnnotations.getState().add({
      tempId: localTempId,
      classId: "c1",
      kind: "bbox",
      geometry: { kind: "bbox", x: 0, y: 0, w: 1, h: 1 },
      frameId: null,
      serverId,
      dirty: true,
    });

    handleOpsMessage(
      upsertMsg(serverId, { kind: "bbox", x: 99, y: 88, w: 7, h: 7 }),
    );

    const local = listLocal();
    expect(local).toHaveLength(1);
    expect(local[0]?.tempId).toBe(localTempId); // unchanged
    expect(local[0]?.serverId).toBe(serverId);
    expect(local[0]?.dirty).toBe(false); // patch flipped dirty off
    const geom = local[0]?.geometry as { x: number; y: number };
    expect(geom.x).toBe(99);
    expect(geom.y).toBe(88);
  });
});

// -------- ops:delete --------------------------------------------------------

describe("handleOpsMessage — ops:delete", () => {
  it("removes the matching draft", () => {
    const id = "ccc33333-3333-3333-3333-333333333333";
    handleOpsMessage(upsertMsg(id));
    expect(listLocal()).toHaveLength(1);

    handleOpsMessage(deleteMsg(id));
    expect(listLocal()).toHaveLength(0);
  });

  it("is a no-op when the annotation is already gone (idempotent)", () => {
    // No local row at all. Must not throw, must not corrupt the store.
    expect(() =>
      handleOpsMessage(deleteMsg("ddd44444-4444-4444-4444-444444444444")),
    ).not.toThrow();
    expect(listLocal()).toHaveLength(0);
  });
});

// -------- ops:batch ---------------------------------------------------------

describe("handleOpsMessage — ops:batch", () => {
  it("applies entries in order so [upsert A, upsert B, delete A] ends with only B", () => {
    const a = "aaa00000-0000-0000-0000-000000000001";
    const b = "bbb00000-0000-0000-0000-000000000002";
    handleOpsMessage(
      batchMsg([
        { type: "ops:upsert", annotation: serverAnnotation(a) },
        { type: "ops:upsert", annotation: serverAnnotation(b) },
        { type: "ops:delete", annotation_id: a },
      ]),
    );
    const local = listLocal();
    expect(local).toHaveLength(1);
    expect(local[0]?.serverId).toBe(b);
  });

  it("ignores entries with missing payload fields without crashing", () => {
    // Defence against future server bugs / version skew.
    expect(() =>
      handleOpsMessage(
        batchMsg([
          { type: "ops:upsert" }, // no annotation
          { type: "ops:delete" }, // no id
        ]),
      ),
    ).not.toThrow();
    expect(listLocal()).toHaveLength(0);
  });
});

// -------- handleResyncMessage ----------------------------------------------

describe("handleResyncMessage", () => {
  it("invalidates both annotation react-query keys for the task", () => {
    const invalidateQueries = vi.fn();
    // Minimal QueryClient stand-in — only the method we call.
    const fakeQc = { invalidateQueries } as unknown as Parameters<
      typeof handleResyncMessage
    >[0];
    const taskId = "eee55555-5555-5555-5555-555555555555";
    const msg: ServerResync = {
      v: PROTOCOL_VERSION,
      type: "resync",
      reason: "gap_replay",
    };
    handleResyncMessage(fakeQc, taskId, msg);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["annotations", taskId] }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["task-annotations-raw", taskId] }),
    );
  });
});

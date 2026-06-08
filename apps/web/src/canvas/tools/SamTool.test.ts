// Armin Mehri — mehri.armin@gmail.com
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SamTool } from "./SamTool";
import type { SamDecoderClient } from "@/canvas/sam/decoderClient";
import type { LocalDecodeResult } from "@/canvas/sam/decoder";

vi.mock("@/api/sam", () => ({
  samApi: { encode: vi.fn(), decode: vi.fn() },
}));
vi.mock("@/canvas/sam/onnx", () => ({
  canDecodeLocally: vi.fn().mockResolvedValue(true),
}));

import { samApi } from "@/api/sam";

const TENSOR_B64 = btoa(String.fromCharCode(0x00, 0x3c, 0x00, 0x38)); // fp16 [1.0, 0.5]

function encodeResult(hash: string) {
  return {
    image_hash: hash,
    shape: [4, 4] as [number, number],
    embedding_b64: null,
    encoder_id: "sam3.1",
    input_size: 1008,
    norm: { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    tensors: {
      "image_embeddings.0": { b64: TENSOR_B64, dtype: "float16", shape: [1, 2] },
      "image_embeddings.1": { b64: TENSOR_B64, dtype: "float16", shape: [1, 2] },
      "image_embeddings.2": { b64: TENSOR_B64, dtype: "float16", shape: [1, 2] },
    },
  };
}

function fakeClient(decodeImpl?: () => Promise<LocalDecodeResult>) {
  const calls: Array<{ prevMask: Uint8Array | null }> = [];
  const client = {
    setEmbeddings: vi.fn(),
    evict: vi.fn(),
    dispose: vi.fn(),
    decode: vi.fn(
      async (
        _key: string,
        _pts: [number, number][],
        _lbl: number[],
        prevMask: Uint8Array | null,
      ) => {
        calls.push({ prevMask });
        if (decodeImpl) return decodeImpl();
        return {
          counts: "16",
          size: [4, 4] as [number, number],
          score: 0.9,
          polygon: [] as [number, number][],
          mask: Uint8Array.from(Array.from({ length: 16 }, () => 1)),
        };
      },
    ),
  };
  return { client: client as unknown as SamDecoderClient, calls, spies: client };
}

let assetSeq = 0;
function makeTool(client: SamDecoderClient) {
  assetSeq += 1;
  return new SamTool(
    `asset-${assetSeq}`,
    () => "class-1",
    () => null, // image task: no frame id
    () => "t-x",
    null,
    () => client,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (samApi.encode as ReturnType<typeof vi.fn>).mockImplementation(async () =>
    encodeResult("h".repeat(32)),
  );
  (samApi.decode as ReturnType<typeof vi.fn>).mockResolvedValue({
    counts: "16",
    size: [4, 4],
    score: 0.5,
    polygon: [],
  });
});

describe("SamTool — Stage 3 local decode wiring", () => {
  it("decodes a click locally (no server /sam/decode) when provisioned + cached", async () => {
    const { client, spies } = fakeClient();
    const tool = makeTool(client);
    await tool.activate();
    expect(spies.setEmbeddings).toHaveBeenCalledOnce(); // embeddings handed to worker

    const result = await tool.addClick({ x: 2, y: 2 }, { pointer: 0 });

    expect(spies.decode).toHaveBeenCalledOnce();
    expect(samApi.decode).not.toHaveBeenCalled(); // local path, no server round-trip
    expect(result?.counts).toBe("16");
  });

  it("falls back to the server for box prompts (box diverges from server decode)", async () => {
    const { client, spies } = fakeClient();
    const tool = makeTool(client);
    tool.setMode("box");
    await tool.activate();

    await tool.setBox([1, 1, 3, 3]);

    expect(spies.decode).not.toHaveBeenCalled();
    expect(samApi.decode).toHaveBeenCalledOnce(); // server box path
  });

  it("falls back to the server when local decode throws (no functionality loss)", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("decode_boom");
    });
    const tool = makeTool(client);
    await tool.activate();

    const result = await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });

    expect(samApi.decode).toHaveBeenCalledOnce(); // fell through to server
    expect(result?.score).toBe(0.5); // server result
  });

  it("replays the previous mask on refinement clicks (track-prev rule)", async () => {
    const { client, calls } = fakeClient();
    const tool = makeTool(client);
    await tool.activate();

    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 }); // first click
    await tool.addClick({ x: 3, y: 3 }, { pointer: 0 }); // refinement

    expect(calls).toHaveLength(2);
    expect(calls[0].prevMask).toBeNull(); // first click: best-by-score
    expect(calls[1].prevMask).toBeInstanceOf(Uint8Array); // refine: tracks prev
    expect(calls[1].prevMask).toHaveLength(16);
  });

  it("does not mark local decode ready when the encode carries no tensors", async () => {
    (samApi.encode as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      image_hash: "h".repeat(32),
      shape: [4, 4],
      embedding_b64: null,
      // no encoder_id / tensors -> server fallback
    }));
    const { client, spies } = fakeClient();
    const tool = makeTool(client);
    await tool.activate();

    await tool.addClick({ x: 1, y: 1 }, { pointer: 0 });

    expect(spies.decode).not.toHaveBeenCalled();
    expect(samApi.decode).toHaveBeenCalledOnce(); // server path
  });
});

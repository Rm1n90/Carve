import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canDecodeLocally,
  checkDecoderModelAvailable,
  isWebGPUAvailable,
} from "@/canvas/sam/onnx";
import { decodeLocally } from "@/canvas/sam/decoder";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_NAVIGATOR = globalThis.navigator;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  Object.defineProperty(globalThis, "navigator", {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
    writable: true,
  });
});

describe("isWebGPUAvailable", () => {
  it("returns false in jsdom (no navigator.gpu)", () => {
    // jsdom navigator does not expose `gpu`; the helper must report false.
    expect(isWebGPUAvailable()).toBe(false);
  });

  it("returns true when navigator.gpu is defined", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: {} },
      configurable: true,
      writable: true,
    });
    expect(isWebGPUAvailable()).toBe(true);
  });
});

describe("checkDecoderModelAvailable", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when the model URL HEAD request 404s", async () => {
    globalThis.fetch = vi.fn(async () =>
      ({ ok: false, status: 404 } as unknown as Response),
    );
    expect(await checkDecoderModelAvailable()).toBe(false);
  });
});

describe("canDecodeLocally", () => {
  it("returns false when WebGPU is unavailable, even if model HEAD ok", async () => {
    // Ensure no navigator.gpu exposed in jsdom default state.
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true } as unknown as Response));
    expect(await canDecodeLocally()).toBe(false);
  });
});

describe("decodeLocally", () => {
  it("rejects with a not_provisioned error when called", async () => {
    await expect(
      decodeLocally({
        embedding_b64: "AAA=",
        shape: [10, 10],
        points: [[1, 1]],
        labels: [1],
      }),
    ).rejects.toThrow(/not_provisioned/);
  });
});

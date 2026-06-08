// Armin Mehri — mehri.armin@gmail.com
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canDecodeLocally,
  decoderUrlFor,
  isWebGPUAvailable,
} from "./onnx";

afterEach(() => {
  vi.unstubAllGlobals();
  // remove any gpu shim a test installed
  if ("gpu" in navigator) {
    delete (navigator as unknown as { gpu?: unknown }).gpu;
  }
});

describe("decoderUrlFor", () => {
  it("returns the per-encoder decoder bundle URL, null for unknown variants", () => {
    expect(decoderUrlFor("sam3.1")).toBe("/models/sam3.1.decoder.onnx");
    expect(decoderUrlFor("sam2.1-large")).toBe("/models/sam2.1-large.decoder.onnx");
    expect(decoderUrlFor("sam2.1-tiny")).toBeNull();
  });
});

describe("isWebGPUAvailable", () => {
  it("reflects navigator.gpu presence", () => {
    expect(isWebGPUAvailable()).toBe(false);
    Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
    expect(isWebGPUAvailable()).toBe(true);
  });
});

describe("canDecodeLocally", () => {
  it("is false without an encoder id (browser falls back to server decode)", async () => {
    expect(await canDecodeLocally()).toBe(false);
    expect(await canDecodeLocally(null)).toBe(false);
  });

  it("is false for an unsupported variant (no decoder bundle)", async () => {
    expect(await canDecodeLocally("sam2.1-tiny")).toBe(false);
  });

  it("is true when the decoder file HEAD-probes OK (WASM EP, no WebGPU needed)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    expect(await canDecodeLocally("sam3.1")).toBe(true);
  });

  it("is false when the decoder file is missing (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await canDecodeLocally("sam3.1")).toBe(false);
  });

  it("is false when the HEAD probe throws (offline / network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await canDecodeLocally("sam3.1")).toBe(false);
  });
});

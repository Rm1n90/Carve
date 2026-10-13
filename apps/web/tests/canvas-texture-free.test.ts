// Armin Mehri — mehri.armin@gmail.com
//
// Pixi v8 keeps a texture's source (its GPU copy and the canvas it came
// from) on a plain texture.destroy(). The editor's masks are full-image
// canvases, so they must be freed with their source, or browsing images
// with many masks runs the tab out of memory.
import { describe, expect, it, vi } from "vitest";
import { destroyCanvasTexture } from "@/components/annotation/AnnotationCanvas";

describe("destroyCanvasTexture", () => {
  it("destroys the texture together with its source", () => {
    const destroy = vi.fn();
    destroyCanvasTexture({ destroy });
    expect(destroy).toHaveBeenCalledWith(true);
  });

  it("ignores what is missing or already gone", () => {
    expect(() => destroyCanvasTexture(null)).not.toThrow();
    expect(() =>
      destroyCanvasTexture({
        destroy: () => {
          throw new Error("destroyed");
        },
      }),
    ).not.toThrow();
  });
});

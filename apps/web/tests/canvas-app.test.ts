import { describe, expect, it, vi } from "vitest";

// Pixi.js requires WebGL which jsdom doesn't have. Mock the bits we touch.
vi.mock("pixi.js", () => {
  class FakeContainer {
    children: any[] = [];
    addChild(...c: any[]) { this.children.push(...c); }
  }
  class FakeStage extends FakeContainer {}
  class FakeApplication {
    stage = new FakeStage();
    canvas = document.createElement("canvas");
    init = vi.fn(async () => {});
    destroy = vi.fn();
  }
  return { Application: FakeApplication, Container: FakeContainer };
});

import { CanvasApp } from "@/canvas/App";

describe("CanvasApp", () => {
  it("creates three layers in order: image, shape, overlay", async () => {
    const c = new CanvasApp({ width: 100, height: 100, backgroundAlpha: 0 });
    await c.init({ width: 100, height: 100, backgroundAlpha: 0 });
    expect((c.app.stage as any).children).toEqual([c.imageLayer, c.shapeLayer, c.overlayLayer]);
  });

  it("attaches canvas element to a host div", async () => {
    const host = document.createElement("div");
    const c = new CanvasApp({ width: 100, height: 100, backgroundAlpha: 0 });
    await c.init({ width: 100, height: 100, backgroundAlpha: 0 });
    c.attach(host);
    expect(host.children.length).toBe(1);
    expect(host.children[0].tagName).toBe("CANVAS");
  });

  it("destroys cleanly", async () => {
    const c = new CanvasApp({ width: 100, height: 100, backgroundAlpha: 0 });
    await c.init({ width: 100, height: 100, backgroundAlpha: 0 });
    c.destroy();
    expect((c.app.destroy as any)).toHaveBeenCalledWith(true, { children: true });
  });
});

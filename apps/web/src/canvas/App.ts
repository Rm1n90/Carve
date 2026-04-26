import { Application, Container } from "pixi.js";

export interface CanvasOptions {
  width: number;
  height: number;
  backgroundAlpha: number;
}

export class CanvasApp {
  app: Application;
  imageLayer: Container;
  shapeLayer: Container;
  overlayLayer: Container;

  constructor(_opts: CanvasOptions) {
    this.app = new Application();
    this.imageLayer = new Container();
    this.shapeLayer = new Container();
    this.overlayLayer = new Container();
  }

  async init(opts: CanvasOptions): Promise<void> {
    await this.app.init({
      width: opts.width,
      height: opts.height,
      backgroundAlpha: opts.backgroundAlpha,
      antialias: true,
    });
    this.app.stage.addChild(this.imageLayer, this.shapeLayer, this.overlayLayer);
  }

  attach(host: HTMLDivElement): void {
    host.appendChild(this.app.canvas);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}

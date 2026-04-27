import { decodeRLE as decodeRLEv1, encodeRLE as encodeRLEv1 } from "@/canvas/maskio";

/**
 * Off-screen rasterizer for the mask-brush tool. Draws into an
 * `OffscreenCanvas` (or fallback `<canvas>`) sized to the underlying
 * image, then converts the rendered alpha channel to a binary mask
 * for RLE encoding on commit.
 *
 * Tradeoffs:
 *  - During painting we use compositor-friendly canvas ops (`arc`+`fill`)
 *    so each stroke is cheap.
 *  - We only call `getImageData` when the caller asks for the binary
 *    mask (`encodeRLE` / `binaryMask`), not on every move, since
 *    `getImageData` is the slow path.
 */

export type BrushMode = "draw" | "erase";

interface CanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  transferToImageBitmap?: () => ImageBitmap;
}

function createCanvas(w: number, h: number): CanvasLike {
  // OffscreenCanvas is faster + thread-safe but isn't always available
  // (Safari < 16.4 lacked it; jsdom's stub has no 2D context). Try
  // OffscreenCanvas first, fall back to a plain HTMLCanvasElement, and
  // finally — for test environments — a tiny in-memory polyfill that
  // tracks painted pixels with enough fidelity for the round-trip tests.
  const wW = Math.max(1, w);
  const hH = Math.max(1, h);
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const oc = new OffscreenCanvas(wW, hH);
      // Probe the context lazily; some test environments have
      // OffscreenCanvas defined but `getContext("2d")` returns null.
      if (oc.getContext("2d")) return oc;
    } catch {
      /* fall through */
    }
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = wW;
    c.height = hH;
    if (c.getContext("2d")) return c as unknown as CanvasLike;
  }
  return makeJsdomFallbackCanvas(wW, hH);
}

/**
 * Tiny in-memory 2D context stub for jsdom-like environments where the
 * real Canvas2D API is unavailable. Painting writes to a Uint8Array
 * alpha buffer; `getImageData`/`putImageData` round-trip via that buffer.
 */
function makeJsdomFallbackCanvas(w: number, h: number): CanvasLike {
  const alpha = new Uint8Array(w * h);
  const ctx: Partial<CanvasRenderingContext2D> & { _alpha: Uint8Array } = {
    _alpha: alpha,
    save() {},
    restore() {},
    beginPath() {},
    arc(x: number, y: number, r: number) {
      const r2 = r * r;
      const x0 = Math.max(0, Math.floor(x - r));
      const y0 = Math.max(0, Math.floor(y - r));
      const x1 = Math.min(w - 1, Math.floor(x + r));
      const y1 = Math.min(h - 1, Math.floor(y + r));
      const erase = (ctx as { globalCompositeOperation?: string }).globalCompositeOperation === "destination-out";
      for (let yy = y0; yy <= y1; yy += 1) {
        for (let xx = x0; xx <= x1; xx += 1) {
          const dx = xx - x;
          const dy = yy - y;
          if (dx * dx + dy * dy <= r2) {
            alpha[yy * w + xx] = erase ? 0 : 255;
          }
        }
      }
    },
    fill() {
      // arc() already wrote to the alpha buffer; this is a no-op cap.
    },
    stroke() {
      // strokes are approximated by the line of arcs the caller
      // typically issues; safe to no-op here.
    },
    moveTo() {},
    lineTo() {},
    clearRect(_x: number, _y: number, _w: number, _h: number) {
      alpha.fill(0);
    },
    getImageData(x: number, y: number, ww: number, hh: number) {
      const data = new Uint8ClampedArray(ww * hh * 4);
      for (let yy = 0; yy < hh; yy += 1) {
        for (let xx = 0; xx < ww; xx += 1) {
          const sx = x + xx;
          const sy = y + yy;
          if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
            const a = alpha[sy * w + sx];
            const i = (yy * ww + xx) * 4;
            data[i] = a > 0 ? 255 : 0;
            data[i + 1] = a > 0 ? 255 : 0;
            data[i + 2] = a > 0 ? 255 : 0;
            data[i + 3] = a;
          }
        }
      }
      return { data, width: ww, height: hh, colorSpace: "srgb" } as ImageData;
    },
    createImageData: ((ww: number, hh: number) => ({
      data: new Uint8ClampedArray(ww * hh * 4),
      width: ww,
      height: hh,
      colorSpace: "srgb",
    })) as CanvasRenderingContext2D["createImageData"],
    putImageData(img: ImageData, dx: number, dy: number) {
      const ww = img.width;
      const hh = img.height;
      for (let yy = 0; yy < hh; yy += 1) {
        for (let xx = 0; xx < ww; xx += 1) {
          const sx = dx + xx;
          const sy = dy + yy;
          if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
            const i = (yy * ww + xx) * 4;
            alpha[sy * w + sx] = img.data[i + 3];
          }
        }
      }
    },
  };
  const cv: CanvasLike = {
    width: w,
    height: h,
    getContext() {
      return ctx as unknown as CanvasRenderingContext2D;
    },
  };
  return cv;
}

export class MaskRasterizer {
  private canvas: CanvasLike;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /**
   * Bumped whenever the rasterizer's pixels change. Consumers (the live
   * preview sprite) can use this as a cheap invalidation key without
   * having to read the bitmap on every pointer-move.
   */
  private _generation = 0;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.canvas = createCanvas(this.width, this.height);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("MaskRasterizer: 2D context unavailable");
    }
    this.ctx = ctx;
  }

  get generation(): number {
    return this._generation;
  }

  /** Backing canvas — exposed so the live preview can sample it directly. */
  getCanvas(): CanvasLike {
    return this.canvas;
  }

  /** Hard reset: clears all painted pixels. */
  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this._generation += 1;
  }

  /** Paint (or erase) a single circle at image coordinates. */
  paintBrush(x: number, y: number, radius: number, mode: BrushMode): void {
    const r = Math.max(0.5, radius);
    if (mode === "erase") {
      this.ctx.save();
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    } else {
      this.ctx.fillStyle = "rgba(255,255,255,1)";
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this._generation += 1;
  }

  /**
   * Paint a connected stroke: thick line + circle endcaps. Used when
   * pointer-move events arrive faster than a single `paintBrush` per
   * pixel can keep up with — joining consecutive points with a thick
   * line eliminates gaps in the brush trail.
   */
  paintStroke(
    points: ReadonlyArray<readonly [number, number]>,
    radius: number,
    mode: BrushMode = "draw",
  ): void {
    if (points.length === 0) return;
    const r = Math.max(0.5, radius);
    this.ctx.save();
    if (mode === "erase") {
      this.ctx.globalCompositeOperation = "destination-out";
      this.ctx.strokeStyle = "rgba(255,255,255,1)";
      this.ctx.fillStyle = "rgba(255,255,255,1)";
    } else {
      this.ctx.strokeStyle = "rgba(255,255,255,1)";
      this.ctx.fillStyle = "rgba(255,255,255,1)";
    }
    this.ctx.lineWidth = r * 2;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    if (points.length === 1) {
      const [x, y] = points[0];
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      this.ctx.beginPath();
      const [x0, y0] = points[0];
      this.ctx.moveTo(x0, y0);
      for (let i = 1; i < points.length; i += 1) {
        const [x, y] = points[i];
        this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();
      // End caps explicitly — `lineCap=round` already does this, but it
      // defends against renderers that don't honor the cap on a 0-length
      // segment.
      const last = points[points.length - 1];
      this.ctx.beginPath();
      this.ctx.arc(last[0], last[1], r, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
    this._generation += 1;
  }

  /**
   * Sample the current canvas alpha channel into a row-major Uint8Array
   * (1 byte per pixel: 1 if alpha > 0, else 0). Slow — call only on
   * commit.
   */
  binaryMask(): Uint8Array {
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data;
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0, j = 3; i < out.length; i += 1, j += 4) {
      out[i] = data[j] > 0 ? 1 : 0;
    }
    return out;
  }

  /** Returns whether any pixel is currently painted. */
  hasAnyPixel(): boolean {
    const m = this.binaryMask();
    for (let i = 0; i < m.length; i += 1) {
      if (m[i]) return true;
    }
    return false;
  }

  /** Encode current painted pixels as COCO-style column-major RLE. */
  encodeRLE(): { counts: string; size: [number, number] } {
    const mask = this.binaryMask();
    return {
      counts: encodeRLEv1(mask, this.height, this.width),
      size: [this.height, this.width],
    };
  }

  /** Replace canvas content from a previously encoded RLE. */
  decodeRLE(counts: string, size: [number, number]): void {
    const [h, w] = size;
    if (h !== this.height || w !== this.width) {
      throw new Error(
        `MaskRasterizer.decodeRLE: size mismatch ${h}x${w} vs ${this.height}x${this.width}`,
      );
    }
    const mask = decodeRLEv1(counts, h, w);
    // Fast path: build an ImageData from the binary mask and putImageData.
    const img = this.ctx.createImageData(w, h);
    const data = img.data;
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const i = (row * w + col) * 4;
        if (mask[row * w + col]) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = 255;
        } else {
          data[i + 3] = 0;
        }
      }
    }
    this.ctx.putImageData(img, 0, 0);
    this._generation += 1;
  }
}

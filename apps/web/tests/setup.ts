import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement ResizeObserver. AnnotationCanvas observes its host
// to size the Pixi renderer. A simple no-op polyfill is enough for tests.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
}

// jsdom doesn't implement Pointer Capture or scrollIntoView. Radix Select
// (added in v3.0) calls both during open/highlight; without these stubs
// tests that drive a Radix Select trigger throw on click.
type ElementProto = HTMLElement & {
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
  scrollIntoView?: () => void;
};
const elementProto = HTMLElement.prototype as ElementProto;
if (typeof elementProto.hasPointerCapture !== "function") {
  elementProto.hasPointerCapture = () => false;
}
if (typeof elementProto.releasePointerCapture !== "function") {
  elementProto.releasePointerCapture = () => undefined;
}
if (typeof elementProto.scrollIntoView !== "function") {
  elementProto.scrollIntoView = () => undefined;
}

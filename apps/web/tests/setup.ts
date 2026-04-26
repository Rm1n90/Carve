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

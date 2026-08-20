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

// Outsourcing hardening — the app now hides export / upload / import /
// duplicate and the whole GPU toolbar (My Model, Auto-Annotate, Smart
// Find, SAM) from non-admin members. The auth store reads its initial
// session out of localStorage at module-init time, and a test with no
// session is treated as "not an admin", which would blank out those
// controls for every pre-existing suite.
//
// Seed a workspace-admin session so the default test identity is
// unrestricted — that is the behaviour every suite written before the
// gate was added assumes. Tests that specifically exercise the
// restricted member view set their own session (see
// tests/role-capability-gating.test.tsx).
window.localStorage.setItem("vaa.accessToken", "test-access-token");
window.localStorage.setItem("vaa.refreshToken", "test-refresh-token");
window.localStorage.setItem(
  "vaa.user",
  JSON.stringify({
    id: "00000000-0000-0000-0000-0000000000ad",
    email: "admin@test.local",
    role: "admin",
  }),
);

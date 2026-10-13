// Armin Mehri — mehri.armin@gmail.com
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  RELOAD_GUARD_MS,
  _resetChunkReloadForTests,
  installChunkReload,
  isChunkLoadError,
  lazyWithReload,
  page,
  reloadForNewBuild,
} from "./chunkReload";

const STALE = new TypeError(
  "Failed to fetch dynamically imported module: https://carve.example/assets/AnnotateAssetPage-DNqe0EWd.js",
);

let reload: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetChunkReloadForTests();
  window.sessionStorage.clear();
  reload = vi.spyOn(page, "reload").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isChunkLoadError", () => {
  it("knows each browser's message", () => {
    expect(isChunkLoadError(STALE)).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: x.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
  });

  it("leaves other errors alone", () => {
    expect(isChunkLoadError(new Error("Request failed with status 500"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  it("reloads once, then not again right away", () => {
    expect(reloadForNewBuild()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // The reloaded page fails again at once: shown, not another reload.
    _resetChunkReloadForTests();
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again for a later deploy", () => {
    vi.useFakeTimers();
    expect(reloadForNewBuild()).toBe(true);
    _resetChunkReloadForTests();
    vi.advanceTimersByTime(RELOAD_GUARD_MS + 1);
    expect(reloadForNewBuild()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the tab cannot remember it did", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(reloadForNewBuild()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("lazyWithReload", () => {
  it("keeps the fallback up while the page reloads onto the new build", async () => {
    const Page = lazyWithReload(() => Promise.reject(STALE));
    render(
      <Suspense fallback={<p>Loading editor…</p>}>
        <Page />
      </Suspense>,
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading editor…")).toBeTruthy();
  });

  it("renders the page when its chunk loads", async () => {
    const Page = lazyWithReload(() =>
      Promise.resolve({ default: () => <p>Editor</p> }),
    );
    render(
      <Suspense fallback={<p>Loading editor…</p>}>
        <Page />
      </Suspense>,
    );
    expect(await screen.findByText("Editor")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("installChunkReload", () => {
  it("reloads for a failed dynamic import Vite reports", () => {
    installChunkReload();
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: STALE });
    window.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores other preload errors", () => {
    installChunkReload();
    const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
      payload: new Error("something else"),
    });
    window.dispatchEvent(event);
    expect(reload).not.toHaveBeenCalled();
  });
});

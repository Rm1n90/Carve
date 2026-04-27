import React from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import {
  ThemeProvider,
  useTheme,
  __testing,
  type ThemePreference,
} from "@/components/theme/ThemeProvider";

// Tiny consumer that exercises the public hook surface.
function ThemeProbe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="pref">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button data-testid="to-light" onClick={() => setTheme("light")}>
        light
      </button>
      <button data-testid="to-dark" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button data-testid="to-system" onClick={() => setTheme("system")}>
        system
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defaults to dark when no preference is stored", () => {
    renderProvider();
    expect(screen.getByTestId("pref").textContent).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("hydrates from localStorage and applies it to documentElement", () => {
    window.localStorage.setItem(__testing.STORAGE_KEY, "light");
    renderProvider();
    expect(screen.getByTestId("pref").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("persists preference to localStorage on setTheme and toggles data-theme", () => {
    renderProvider();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    act(() => {
      screen.getByTestId("to-light").click();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(__testing.STORAGE_KEY)).toBe("light");

    act(() => {
      screen.getByTestId("to-dark").click();
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(__testing.STORAGE_KEY)).toBe("dark");
  });

  it("resolves 'system' against prefers-color-scheme: dark", () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMedia,
    });

    renderProvider();

    act(() => {
      screen.getByTestId("to-system").click();
    });

    expect(screen.getByTestId("pref").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(__testing.STORAGE_KEY)).toBe("system");
  });

  it("survives a localStorage round-trip across remounts", () => {
    const { unmount } = renderProvider();

    act(() => {
      screen.getByTestId("to-light").click();
    });
    expect(window.localStorage.getItem(__testing.STORAGE_KEY)).toBe("light");

    unmount();
    document.documentElement.removeAttribute("data-theme");

    renderProvider();
    expect(screen.getByTestId("pref").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // The exported testing constants are stable.
    const expectedKey: typeof __testing.STORAGE_KEY = "carve.theme.v1";
    const expectedDefault: ThemePreference = __testing.DEFAULT_PREFERENCE;
    expect(__testing.STORAGE_KEY).toBe(expectedKey);
    expect(expectedDefault).toBe("dark");
  });
});

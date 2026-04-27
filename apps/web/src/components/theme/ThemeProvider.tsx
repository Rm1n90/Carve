import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "carve.theme.v1";
const DEFAULT_PREFERENCE: ThemePreference = "dark";

interface ThemeContextValue {
  /** User-facing preference: dark | light | system. */
  theme: ThemePreference;
  /** Concrete theme actually applied to the DOM (system → resolved). */
  resolved: ResolvedTheme;
  /** Persist a new preference and update the DOM immediately. */
  setTheme: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    // localStorage may throw in private mode / blocked storage; fall through.
  }
  return DEFAULT_PREFERENCE;
}

function readSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolvePreference(pref: ThemePreference): ResolvedTheme {
  return pref === "system" ? readSystemTheme() : pref;
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(() => readStoredPreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolvePreference(readStoredPreference()),
  );

  // Apply the resolved theme to the documentElement on every change. The
  // pre-paint script in index.html handles the very first paint; this keeps
  // the DOM in sync after the React tree mounts and on every toggle.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // When preference is "system", follow live OS changes.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent): void => {
      setResolved(event.matches ? "dark" : "light");
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    return undefined;
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    setResolved(resolvePreference(next));
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Persistence failure is non-fatal — UI still updates in-memory.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}

export const __testing = {
  STORAGE_KEY,
  DEFAULT_PREFERENCE,
};

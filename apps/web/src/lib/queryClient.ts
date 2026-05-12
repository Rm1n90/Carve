// Armin Mehri — mehri.armin@gmail.com
import { QueryClient } from "@tanstack/react-query";

/**
 * Singleton React Query client shared by main.tsx (provider) and the
 * auth flow (cache wipe on login / logout). Exporting it as a module
 * lets imperative code outside the React tree call ``queryClient
 * .clear()`` without prop-drilling a context.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Without an explicit retry cap, React Query retries failed
      // queries 3 times with exponential backoff. Each retry is an
      // in-flight request, which keeps Chrome's tab spinner spinning
      // long after the user sees the page render. Cap at 1 and let
      // the affected component decide if it needs more.
      retry: 1,
      // Window-focus refetches are useful for live data, but most
      // queries in this app already use ``refetchOnWindowFocus: false``
      // explicitly. Disable the default so tabbing back doesn't briefly
      // relight the spinner for stale-but-good data.
      refetchOnWindowFocus: false,
    },
  },
});

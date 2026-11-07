// Armin Mehri — mehri.armin@gmail.com
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAuth, type User } from "./store";

/**
 * Keeps the signed-in user, above all their role, in step with the server.
 *
 * The user is stored at login and refreshed access tokens never touched
 * it, so a role changed after login (a promotion to superadmin, a
 * demotion) never reached the page until the next login: a superadmin
 * whose browser still said "admin" saw none of the superadmin controls.
 * Re-read on load, when the tab is focused again, and every few minutes.
 */
export function useSessionUserSync(enabled: boolean): void {
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => (await api.get<User>("/auth/me")).data,
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const fresh = me.data;
  useEffect(() => {
    if (!fresh) return;
    const current = useAuth.getState().user;
    // Never switch accounts from here: an answer for another user can
    // only be a stale one from before a logout and a new login.
    if (current && current.id !== fresh.id) return;
    if (current && current.role === fresh.role && current.email === fresh.email) return;
    useAuth.getState().setUser({ id: fresh.id, email: fresh.email, role: fresh.role });
  }, [fresh]);
}

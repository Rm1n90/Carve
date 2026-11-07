// Armin Mehri — mehri.armin@gmail.com
import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "./store";

/**
 * Route guard for superadmin-only pages (Settings → Configuration). Like
 * {@link RequireAdmin} it is a navigation nicety: the API refuses the
 * calls for anyone else independently.
 */
export function RequireSuperadmin({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.accessToken);
  const role = useAuth((s) => s.user?.role ?? null);
  if (!token) return <Navigate to="/login" replace />;
  if (role !== "superadmin") return <Navigate to="/settings/profile" replace />;
  return <>{children}</>;
}

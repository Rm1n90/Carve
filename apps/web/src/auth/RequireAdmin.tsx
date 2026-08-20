// Armin Mehri — mehri.armin@gmail.com
import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "./store";

/**
 * Outsourcing hardening — route guard for workspace-admin-only pages
 * (Models, System, Jobs).
 *
 * Wraps {@link RequireAuth}'s job and adds the role check, so a member
 * who types `/models/yolo` or `/system` is bounced to `/projects`
 * rather than landing on a page whose every request will 403. Purely a
 * navigation nicety: the API refuses those calls independently, so this
 * guard is not what keeps the data safe.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.accessToken);
  const role = useAuth((s) => s.user?.role ?? null);
  if (!token) return <Navigate to="/login" replace />;
  if (role !== "admin") return <Navigate to="/projects" replace />;
  return <>{children}</>;
}

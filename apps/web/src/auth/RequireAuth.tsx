// Armin Mehri — mehri.armin@gmail.com
import type { ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "./store";

export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.accessToken);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

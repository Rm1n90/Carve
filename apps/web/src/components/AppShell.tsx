import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/auth/store";
import { logout } from "@/auth/api";

export function AppShell({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  const nav = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 24px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <Link to="/" style={{ fontWeight: 700, textDecoration: "none", color: "inherit" }}>
          VisualAutoAnnotator
        </Link>
        <nav style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Link to={"/projects" as any}>Projects</Link>
          {user && (
            <>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {user.email} ({user.role})
              </span>
              <button
                onClick={() => {
                  logout();
                  nav({ to: "/login" });
                }}
              >
                Sign out
              </button>
            </>
          )}
        </nav>
      </header>
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}

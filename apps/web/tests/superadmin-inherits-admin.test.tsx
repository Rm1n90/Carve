import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";

/**
 * A SuperAdmin must never see LESS than an admin.
 *
 * This shipped broken once: `RequireAdmin` and several pages compared the
 * role to the literal "admin", so the tier ABOVE admin was redirected
 * away from Models / System / Jobs and lost its Settings tabs. The
 * backend had the identical bug in 15 places.
 *
 * The rule is: never compare a role to "admin" — go through
 * `hasAdminAuthority` / `useCapabilities`. These tests pin that.
 */

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    Navigate: (props: { to: string }) => {
      navigateSpy(props.to);
      return <div data-testid="redirected">{props.to}</div>;
    },
  };
});

import { hasAdminAuthority, useCapabilities } from "@/auth/capabilities";
import { RequireAdmin } from "@/auth/RequireAdmin";
import { useAuth, type Role } from "@/auth/store";

function signInAs(role: Role): void {
  useAuth.getState().setSession({
    accessToken: "t",
    refreshToken: "r",
    user: { id: `u-${role}`, email: `${role}@t.local`, role },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuth.getState().clear();
});

describe("hasAdminAuthority", () => {
  it("accepts both admin tiers and rejects the rest", () => {
    expect(hasAdminAuthority("superadmin")).toBe(true);
    expect(hasAdminAuthority("admin")).toBe(true);
    expect(hasAdminAuthority("member")).toBe(false);
    expect(hasAdminAuthority("viewer")).toBe(false);
    expect(hasAdminAuthority(null)).toBe(false);
    expect(hasAdminAuthority(undefined)).toBe(false);
  });
});

describe("RequireAdmin route guard", () => {
  it.each<Role>(["superadmin", "admin"])("lets %s through", (role) => {
    signInAs(role);
    render(
      <RequireAdmin>
        <div data-testid="protected">models page</div>
      </RequireAdmin>,
    );
    expect(screen.getByTestId("protected")).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it.each<Role>(["member", "viewer"])("redirects %s away", (role) => {
    signInAs(role);
    render(
      <RequireAdmin>
        <div data-testid="protected">models page</div>
      </RequireAdmin>,
    );
    expect(screen.queryByTestId("protected")).toBeNull();
    expect(navigateSpy).toHaveBeenCalledWith("/projects");
  });

  it("sends a signed-out visitor to login, not to /projects", () => {
    useAuth.getState().clear();
    render(
      <RequireAdmin>
        <div data-testid="protected">models page</div>
      </RequireAdmin>,
    );
    expect(navigateSpy).toHaveBeenCalledWith("/login");
  });
});

describe("capabilities parity", () => {
  it("gives a superadmin at least everything an admin has", () => {
    signInAs("admin");
    const { result: asAdmin } = renderHook(() => useCapabilities());
    const adminCaps = { ...asAdmin.current };
    cleanup();

    signInAs("superadmin");
    const { result: asSuper } = renderHook(() => useCapabilities());

    for (const [key, value] of Object.entries(adminCaps)) {
      if (value === true) {
        expect(
          asSuper.current[key as keyof typeof adminCaps],
          `superadmin lost "${key}" that admin has`,
        ).toBe(true);
      }
    }
    expect(asSuper.current.isSuperAdmin).toBe(true);
    expect(adminCaps.isSuperAdmin).toBe(false);
  });
});

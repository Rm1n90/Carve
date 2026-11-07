/**
 * The signed-in user's role follows the server: a browser that logged in
 * as "admin" before the account became superadmin must pick up the new
 * role without a new login, or the superadmin controls stay hidden.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/client", () => ({ api: { get: vi.fn() } }));

import { api } from "@/api/client";
import { useAuth } from "@/auth/store";
import { useSessionUserSync } from "@/auth/useSessionUserSync";

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function Probe({ enabled = true }: { enabled?: boolean }) {
  useSessionUserSync(enabled);
  return null;
}

function renderProbe(enabled = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.getState().setSession({
    accessToken: "a",
    refreshToken: "r",
    user: { id: "u1", email: "sa@example.com", role: "admin" },
  });
});

afterEach(() => {
  cleanup();
  useAuth.getState().clear();
});

describe("useSessionUserSync", () => {
  it("takes the role from the server and keeps it after a reload", async () => {
    get.mockResolvedValue({
      data: { id: "u1", email: "sa@example.com", role: "superadmin", blocked: false },
    });
    renderProbe();
    await waitFor(() => expect(useAuth.getState().user?.role).toBe("superadmin"));
    expect(get).toHaveBeenCalledWith("/auth/me");
    expect(JSON.parse(localStorage.getItem("vaa.user") ?? "{}")).toEqual({
      id: "u1",
      email: "sa@example.com",
      role: "superadmin",
    });
  });

  it("never switches to another account", async () => {
    get.mockResolvedValue({ data: { id: "u2", email: "x@example.com", role: "superadmin" } });
    renderProbe();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(useAuth.getState().user).toEqual({ id: "u1", email: "sa@example.com", role: "admin" });
  });

  it("asks nothing when signed out", async () => {
    renderProbe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });
});

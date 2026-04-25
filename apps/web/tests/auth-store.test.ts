import { describe, expect, it, beforeEach } from "vitest";
import { useAuth } from "@/auth/store";

describe("auth store", () => {
  beforeEach(() => {
    useAuth.getState().clear();
    localStorage.clear();
  });

  it("starts unauthenticated", () => {
    const s = useAuth.getState();
    expect(s.accessToken).toBeNull();
    expect(s.user).toBeNull();
  });

  it("stores tokens and user after setSession", () => {
    useAuth.getState().setSession({
      accessToken: "a.b.c",
      refreshToken: "r.s.t",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    const s = useAuth.getState();
    expect(s.accessToken).toBe("a.b.c");
    expect(s.refreshToken).toBe("r.s.t");
    expect(s.user?.email).toBe("u@x.com");
  });

  it("persists tokens to localStorage", () => {
    useAuth.getState().setSession({
      accessToken: "a",
      refreshToken: "r",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    expect(localStorage.getItem("vaa.accessToken")).toBe("a");
    expect(localStorage.getItem("vaa.refreshToken")).toBe("r");
  });

  it("clear removes tokens and user", () => {
    useAuth.getState().setSession({
      accessToken: "a",
      refreshToken: "r",
      user: { id: "1", email: "u@x.com", role: "member" },
    });
    useAuth.getState().clear();
    expect(useAuth.getState().accessToken).toBeNull();
    expect(localStorage.getItem("vaa.accessToken")).toBeNull();
  });
});

/**
 * Plan-13 Phase 7 Task 4 -- InviteAcceptPage tests.
 *
 * Covers the three branches called out in the spec:
 *   1. Mocked preview + new-user path: register form -> submit -> calls
 *      invitesApi.accept with {token, password}.
 *   2. Existing-user path: login form -> submits login then accept.
 *   3. 410 expired preview -> friendly error message rendered.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => () => undefined,
  useParams: () => ({ token: "tok-abc" }),
}));

vi.mock("@/lib/toast", () => ({
  showToast: vi.fn(),
}));

const setSession = vi.fn();
vi.mock("@/auth/store", () => ({
  useAuth: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({ user: null, accessToken: null, refreshToken: null }),
    {
      getState: () => ({
        setSession,
        clear: vi.fn(),
        setAccessToken: vi.fn(),
      }),
    },
  ),
}));

vi.mock("@/auth/api", () => ({
  login: vi.fn(),
}));

vi.mock("@/api/invites", () => ({
  invitesApi: {
    preview: vi.fn(),
    accept: vi.fn(),
  },
}));

import { invitesApi } from "@/api/invites";
import { login as authLogin } from "@/auth/api";
import { InviteAcceptPage } from "@/pages/InviteAcceptPage";

const onAccepted = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("InviteAcceptPage", () => {
  it("submits accept(token, password) on the new-user path", async () => {
    (invitesApi.preview as ReturnType<typeof vi.fn>).mockResolvedValue({
      project_id: "p-1",
      project_name: "Acme",
      email: "fresh@x.com",
      role: "member",
      requires_password: true,
    });
    (invitesApi.accept as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u-1", email: "fresh@x.com", role: "member" },
      project_id: "p-1",
      role: "member",
      jwt: "jwt-token",
      refresh_token: "ref-token",
    });

    render(<InviteAcceptPage token="tok-abc" onAccepted={onAccepted} />);

    expect(await screen.findByTestId("invite-email")).toHaveValue(
      "fresh@x.com",
    );
    fireEvent.change(screen.getByTestId("invite-password"), {
      target: { value: "hunter22long" },
    });
    fireEvent.change(screen.getByTestId("invite-confirm"), {
      target: { value: "hunter22long" },
    });
    fireEvent.click(screen.getByTestId("invite-register-submit"));

    await waitFor(() => {
      expect(invitesApi.accept).toHaveBeenCalledWith({
        token: "tok-abc",
        password: "hunter22long",
      });
    });
    await waitFor(() => {
      expect(setSession).toHaveBeenCalled();
      expect(onAccepted).toHaveBeenCalled();
    });
  });

  it("logs in then calls accept on the existing-user path", async () => {
    (invitesApi.preview as ReturnType<typeof vi.fn>).mockResolvedValue({
      project_id: "p-2",
      project_name: "Globex",
      email: "alice@x.com",
      role: "member",
      requires_password: false,
    });
    (authLogin as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (invitesApi.accept as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "u-2", email: "alice@x.com", role: "member" },
      project_id: "p-2",
      role: "member",
      jwt: null,
      refresh_token: null,
    });

    render(<InviteAcceptPage token="tok-abc" onAccepted={onAccepted} />);

    expect(
      await screen.findByTestId("invite-login-password"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("invite-login-password"), {
      target: { value: "hunter22long" },
    });
    fireEvent.click(screen.getByTestId("invite-login-submit"));

    await waitFor(() => {
      expect(authLogin).toHaveBeenCalledWith("alice@x.com", "hunter22long");
    });
    await waitFor(() => {
      expect(invitesApi.accept).toHaveBeenCalledWith({ token: "tok-abc" });
      expect(onAccepted).toHaveBeenCalled();
    });
  });

  it("renders a friendly message when the preview returns 410", async () => {
    (invitesApi.preview as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 410, data: { error: "invite_expired" } },
    });

    render(<InviteAcceptPage token="tok-abc" onAccepted={onAccepted} />);

    const err = await screen.findByTestId("invite-load-error");
    expect(err.textContent).toMatch(/expired/i);
  });
});

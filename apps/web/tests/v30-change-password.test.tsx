/**
 * v3.0 — self-service password change (audit Bug 16).
 *
 * The Settings → Profile page used to ship a hard-disabled password card
 * with a "Coming soon" badge. This suite exercises the live form:
 *  1. Renders enabled inputs + a submit button (no "Coming soon").
 *  2. Submit button is disabled when both fields are empty.
 *  3. Submit button stays disabled while the new password is < 8 chars.
 *  4. Filling valid values + submitting calls `changePassword` with the
 *     exact arguments and emits a "Password updated" toast.
 *  5. A 401 response surfaces "Current password is wrong" via the toast bus.
 */
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/settings/profile" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "user@example.com", role: "member" },
      accessToken: "tok",
      refreshToken: "ref",
      setSession: vi.fn(),
      setAccessToken: vi.fn(),
      clear: vi.fn(),
    }),
}));

vi.mock("@/auth/api", () => ({
  changePassword: vi.fn(),
}));

vi.mock("@/api/api_keys", () => ({
  apiKeysApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("@/api/members", () => ({
  membersApi: {
    list: vi.fn().mockResolvedValue([]),
    setRole: vi.fn(),
  },
}));

import { changePassword } from "@/auth/api";
import { SettingsProfilePage } from "@/pages/SettingsPages";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { subscribeToasts, _resetToastBusForTests } from "@/lib/toast";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  _resetToastBusForTests();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("v3.0 — Settings change-password card", () => {
  it("renders the form with enabled inputs and no 'Coming soon' badge", () => {
    render(wrap(<SettingsProfilePage />));

    const current = screen.getByTestId(
      "change-password-current",
    ) as HTMLInputElement;
    const next = screen.getByTestId(
      "change-password-new",
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      "change-password-submit",
    ) as HTMLButtonElement;

    // Inputs are reachable, password type, and not disabled.
    expect(current.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    expect(current.type).toBe("password");
    expect(next.type).toBe("password");

    // Submit starts disabled (empty form).
    expect(submit.disabled).toBe(true);

    // Hint copy and absence of the "Coming soon" badge.
    expect(screen.getByTestId("change-password-hint")).toHaveTextContent(
      /min 8 characters/i,
    );
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("keeps submit disabled when new password is < 8 characters", () => {
    render(wrap(<SettingsProfilePage />));

    const current = screen.getByTestId(
      "change-password-current",
    ) as HTMLInputElement;
    const next = screen.getByTestId(
      "change-password-new",
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      "change-password-submit",
    ) as HTMLButtonElement;

    fireEvent.change(current, { target: { value: "old-pass-1" } });
    fireEvent.change(next, { target: { value: "short" } });

    expect(submit.disabled).toBe(true);
  });

  it("submits with the exact arguments and toasts success on resolve", async () => {
    (changePassword as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    const events: string[] = [];
    const unsub = subscribeToasts((t) =>
      events.push(`${t.variant}:${t.message}`),
    );

    render(wrap(<SettingsProfilePage />));

    const current = screen.getByTestId(
      "change-password-current",
    ) as HTMLInputElement;
    const next = screen.getByTestId(
      "change-password-new",
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      "change-password-submit",
    ) as HTMLButtonElement;

    fireEvent.change(current, { target: { value: "old-pass-1" } });
    fireEvent.change(next, { target: { value: "new-pass-1" } });

    // Once the new password is long enough the button enables.
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledTimes(1);
    });
    expect(changePassword).toHaveBeenCalledWith("old-pass-1", "new-pass-1");

    await waitFor(() => {
      expect(events).toContain("success:Password updated");
    });

    unsub();
  });

  it("shows a 'Current password is wrong' toast on a 401 response", async () => {
    const err = Object.assign(new Error("401"), {
      response: { status: 401 },
    });
    (changePassword as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const events: string[] = [];
    const unsub = subscribeToasts((t) =>
      events.push(`${t.variant}:${t.message}`),
    );

    render(wrap(<SettingsProfilePage />));

    fireEvent.change(screen.getByTestId("change-password-current"), {
      target: { value: "wrong-current" },
    });
    fireEvent.change(screen.getByTestId("change-password-new"), {
      target: { value: "new-pass-1" },
    });
    fireEvent.click(screen.getByTestId("change-password-submit"));

    await waitFor(() => {
      expect(events).toContain("error:Current password is wrong");
    });

    unsub();
  });
});

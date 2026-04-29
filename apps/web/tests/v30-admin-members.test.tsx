/**
 * v3.0 Bug 14 — admin invite + delete member from Settings.
 *
 * Asserts the rewritten SettingsMembersPage:
 *   - As admin, "Invite member" button is rendered.
 *   - Clicking it opens a Dialog with email/password/role inputs.
 *   - Submitting the dialog calls membersApi.create with the typed values.
 *   - As non-admin, the button is hidden.
 *   - Each row exposes a 3-dot menu with "Delete member" that fires the
 *     confirm flow + membersApi.delete on accept.
 *   - The 3-dot menu is hidden on the current user's own row (no self-delete).
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/settings/members" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

interface AuthUser {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
}

const authState: { user: AuthUser } = {
  user: { id: "admin-1", email: "admin@example.com", role: "admin" },
};

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: authState.user,
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
    list: vi.fn(),
    setRole: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

import { membersApi } from "@/api/members";
import { SettingsMembersPage } from "@/pages/SettingsPages";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

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

const adminUser = {
  id: "admin-1",
  email: "admin@example.com",
  role: "admin" as const,
};
const memberRow = {
  id: "member-1",
  email: "alice@example.com",
  role: "member" as const,
};
const otherAdmin = {
  id: "admin-2",
  email: "second@example.com",
  role: "admin" as const,
};

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  authState.user = adminUser;
});

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = adminUser;
  (membersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
    adminUser,
    otherAdmin,
    memberRow,
  ]);
});

describe("v3.0 Bug 14 — Settings → Members invite + delete", () => {
  it("renders 'Invite member' for admins", async () => {
    render(wrap(<SettingsMembersPage />));
    expect(
      await screen.findByTestId("members-invite-button"),
    ).toBeInTheDocument();
  });

  it("hides 'Invite member' for non-admin users", async () => {
    authState.user = { ...memberRow };
    render(wrap(<SettingsMembersPage />));
    await screen.findByText(/alice@example\.com/i);
    expect(screen.queryByTestId("members-invite-button")).toBeNull();
  });

  it("opens the invite dialog with email/password/role fields", async () => {
    render(wrap(<SettingsMembersPage />));
    fireEvent.click(await screen.findByTestId("members-invite-button"));

    expect(await screen.findByTestId("invite-member-email")).toBeInTheDocument();
    expect(screen.getByTestId("invite-member-password")).toBeInTheDocument();
    expect(screen.getByTestId("invite-member-role-trigger")).toBeInTheDocument();
  });

  it("submits create() with the typed values", async () => {
    (membersApi.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "new-1",
      email: "new@example.com",
      role: "member",
    });
    render(wrap(<SettingsMembersPage />));
    fireEvent.click(await screen.findByTestId("members-invite-button"));

    fireEvent.change(await screen.findByTestId("invite-member-email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByTestId("invite-member-password"), {
      target: { value: "hunter22" },
    });

    fireEvent.click(screen.getByTestId("invite-member-submit"));

    await waitFor(() =>
      expect(membersApi.create).toHaveBeenCalledTimes(1),
    );
    expect(membersApi.create).toHaveBeenCalledWith(
      "new@example.com",
      "hunter22",
      "member",
    );
  });

  it("keeps submit disabled when password is < 8 characters", async () => {
    render(wrap(<SettingsMembersPage />));
    fireEvent.click(await screen.findByTestId("members-invite-button"));

    fireEvent.change(await screen.findByTestId("invite-member-email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByTestId("invite-member-password"), {
      target: { value: "short" },
    });

    expect(
      (screen.getByTestId("invite-member-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renders the 3-dot menu on a deletable member row and fires delete after confirm", async () => {
    (membersApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(wrap(<SettingsMembersPage />));

    const trigger = await screen.findByTestId(
      `member-menu-trigger-${memberRow.id}`,
    );
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });

    const deleteItem = await screen.findByTestId(
      `member-menu-delete-${memberRow.id}`,
    );
    fireEvent.click(deleteItem);

    const confirmBtn = await screen.findByRole("button", { name: /^delete$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(membersApi.delete).toHaveBeenCalledWith(memberRow.id),
    );
  });

  it("hides the 3-dot menu on the current user's own row (no self-delete)", async () => {
    render(wrap(<SettingsMembersPage />));
    await screen.findByText(/admin@example\.com/i);
    expect(
      screen.queryByTestId(`member-menu-trigger-${adminUser.id}`),
    ).toBeNull();
  });

  it("hides the 3-dot menu when the viewer isn't an admin", async () => {
    // Non-admin viewers never see the delete affordance — the row's
    // canDelete prop is gated on isAdmin && !isMe && !isLastAdmin.
    authState.user = { ...memberRow };
    (membersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      otherAdmin,
      memberRow,
    ]);
    render(wrap(<SettingsMembersPage />));

    await screen.findByText(/second@example\.com/i);
    expect(
      screen.queryByTestId(`member-menu-trigger-${otherAdmin.id}`),
    ).toBeNull();
  });
});

/**
 * What the superadmin can do from the web app beyond passwords, blocks
 * and sign-outs:
 *
 *  1. Members show when each person last signed in.
 *  2. Someone can be made superadmin, after a warning.
 *  3. A member's email can be changed; the server's refusal is shown.
 *  4. A member's API keys can be seen and revoked.
 *  5. Removed members are listed and can be restored.
 *  6. The activity log lists what happened, filterable by kind and person.
 *  7. A database backup can be requested from Configuration.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/settings/members" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "sa-1", email: "sa@example.com", role: "superadmin" },
      accessToken: "tok",
    }),
}));

vi.mock("@/auth/api", () => ({ changePassword: vi.fn() }));
vi.mock("@/api/api_keys", () => ({
  apiKeysApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
}));
vi.mock("@/api/invites", () => ({
  invitesApi: { list: vi.fn().mockResolvedValue([]) },
  projectMembersApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/api/members", () => ({
  membersApi: {
    list: vi.fn(),
    projectsByUser: vi.fn().mockResolvedValue({}),
    setRole: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    setEmail: vi.fn(),
    apiKeys: vi.fn(),
    revokeApiKey: vi.fn(),
    removed: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock("@/api/audit", () => ({ auditApi: { workspace: vi.fn() } }));
vi.mock("@/api/backups", () => ({ backupsApi: { list: vi.fn(), run: vi.fn() } }));
vi.mock("@/api/appSettings", () => ({
  appSettingsApi: { list: vi.fn(), save: vi.fn(), clear: vi.fn(), test: vi.fn(), restartModel: vi.fn() },
}));

import { membersApi } from "@/api/members";
import { auditApi } from "@/api/audit";
import { backupsApi } from "@/api/backups";
import { appSettingsApi } from "@/api/appSettings";
import { SettingsMembersPage } from "@/pages/SettingsPages";
import { SettingsActivityPage } from "@/pages/SettingsActivityPage";
import { SettingsConfigurationPage } from "@/pages/SettingsConfigurationPage";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

const m = membersApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

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

const ME = { id: "sa-1", email: "sa@example.com", role: "superadmin" as const };
const ADMIN = {
  id: "admin-1",
  email: "admin@example.com",
  role: "admin" as const,
  last_sign_in_at: "2026-11-01T09:30:00Z",
};
const MEMBER = { id: "member-1", email: "alice@example.com", role: "member" as const };

async function openMenu(id: string) {
  const trigger = await screen.findByTestId(`member-menu-trigger-${id}`);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue([ME, ADMIN, MEMBER]);
  m.removed.mockResolvedValue([]);
  m.projectsByUser.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

describe("Members — superadmin", () => {
  it("shows when each person last signed in", async () => {
    render(wrap(<SettingsMembersPage />));
    expect(await screen.findByTestId("member-last-sign-in-admin-1")).toHaveTextContent(
      /Last sign-in/,
    );
    expect(screen.getByTestId("member-last-sign-in-member-1")).toHaveTextContent(
      "No sign-in recorded yet",
    );
  });

  it("makes someone superadmin only after the warning is accepted", async () => {
    m.setRole.mockResolvedValue({ ...ADMIN, role: "superadmin" });
    render(wrap(<SettingsMembersPage />));
    const trigger = await screen.findByLabelText(`Role for ${ADMIN.email}`);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "superadmin" }));
    expect(await screen.findByText(`Make ${ADMIN.email} a superadmin?`)).toBeInTheDocument();
    expect(m.setRole).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make superadmin" }));
    await waitFor(() => expect(m.setRole).toHaveBeenCalledWith("admin-1", "superadmin"));
  });

  it("changes an email and shows why the server refused one", async () => {
    m.setEmail.mockRejectedValueOnce({
      response: { status: 409, data: { error: "email_belongs_to_removed_member" } },
    });
    m.setEmail.mockResolvedValueOnce({ ...MEMBER, email: "alice@new.example.com" });
    render(wrap(<SettingsMembersPage />));
    await openMenu("member-1");
    fireEvent.click(await screen.findByTestId("member-menu-email-member-1"));
    const input = await screen.findByTestId("change-email-input");
    fireEvent.change(input, { target: { value: "gone@example.com" } });
    fireEvent.click(screen.getByTestId("change-email-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/removed account uses that email/);
    fireEvent.change(input, { target: { value: "alice@new.example.com" } });
    fireEvent.click(screen.getByTestId("change-email-submit"));
    await waitFor(() =>
      expect(m.setEmail).toHaveBeenLastCalledWith("member-1", "alice@new.example.com"),
    );
    await waitFor(() => expect(screen.queryByTestId("change-email-input")).toBeNull());
  });

  it("lists a member's API keys and revokes one", async () => {
    m.apiKeys.mockResolvedValue([
      {
        id: "k1",
        name: "ci",
        prefix: "ck_abcd",
        created_at: "2026-10-01T10:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
    ]);
    m.revokeApiKey.mockResolvedValue(undefined);
    render(wrap(<SettingsMembersPage />));
    await openMenu("admin-1");
    fireEvent.click(await screen.findByTestId("member-menu-api-keys-admin-1"));
    const list = await screen.findByTestId("member-api-keys");
    expect(within(list).getByText(/never used/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Revoke ci" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(m.revokeApiKey).toHaveBeenCalledWith("admin-1", "k1"));
  });

  it("restores a removed member", async () => {
    m.removed.mockResolvedValue([
      { id: "gone-1", email: "gone@example.com", role: "member", deleted_at: "2026-10-20T08:00:00Z" },
    ]);
    m.restore.mockResolvedValue({ id: "gone-1", email: "gone@example.com", role: "member" });
    render(wrap(<SettingsMembersPage />));
    const section = await screen.findByTestId("removed-members");
    fireEvent.click(within(section).getByRole("button", { name: "Restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(m.restore).toHaveBeenCalledWith("gone-1"));
  });
});

describe("Activity log", () => {
  it("lists events with names and filters by kind and person", async () => {
    const workspace = auditApi.workspace as unknown as ReturnType<typeof vi.fn>;
    workspace.mockResolvedValue({
      items: [
        {
          id: "e1",
          occurred_at: "2026-11-01T10:00:00Z",
          actor_id: "sa-1",
          actor_email: "sa@example.com",
          action: "task.deleted",
          target_type: "task",
          target_id: null,
          project_id: "p1",
          project_name: "Shelf audit",
          summary: "deleted task T",
          metadata: null,
        },
      ],
      next_cursor: null,
    });
    render(wrap(<SettingsActivityPage />));
    expect(await screen.findByText("deleted task T")).toBeInTheDocument();
    expect(screen.getByText(/sa@example.com · Shelf audit/)).toBeInTheDocument();
    expect(workspace).toHaveBeenLastCalledWith({}, null);

    fireEvent.change(screen.getByLabelText("What"), { target: { value: "sign-ins" } });
    await waitFor(() =>
      expect(workspace).toHaveBeenLastCalledWith({ action: "user.signed_in" }, null),
    );
    await screen.findByRole("option", { name: ADMIN.email });
    fireEvent.change(screen.getByLabelText("Who"), { target: { value: "admin-1" } });
    await waitFor(() =>
      expect(workspace).toHaveBeenLastCalledWith(
        { action: "user.signed_in", person: "admin-1" },
        null,
      ),
    );
  });
});

describe("Configuration — backups", () => {
  it("requests a backup now", async () => {
    (appSettingsApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      applies_within_seconds: 5,
      services: { model: { reachable: true, pending_restart: false } },
      startup: [],
      settings: [
        {
          key: "BACKUP_HOUR",
          group: "Database backups",
          label: "Hour of the daily backup",
          help: "UTC.",
          kind: "int",
          minimum: 0,
          maximum: 23,
          unit: null,
          choices: [],
          allow_empty: false,
          testable: false,
          service: "backup",
          options: [],
          option_labels: [],
          links: [],
          source: "default",
          env_set: false,
          unreadable: false,
          updated_at: null,
          updated_by: null,
          value: 2,
          hint: null,
          env_hint: null,
        },
      ],
    });
    const listing = {
      available: true,
      running: false,
      requested_at: null,
      files: [
        {
          tier: "daily",
          name: "carve-20261101-020008.sql.gz",
          size_bytes: 882_502_659,
          created_at: "2026-11-01T02:02:00Z",
        },
      ],
    };
    (backupsApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(listing);
    (backupsApi.run as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...listing,
      requested_at: new Date().toISOString(),
    });
    localStorage.clear();
    render(wrap(<SettingsConfigurationPage />));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Backups" }), { button: 0 });
    const panel = await screen.findByTestId("backups-panel");
    expect(within(panel).getByText(/Latest backup/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Back up now" }));
    expect(await within(panel).findByText(/within 30 seconds/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Back up now" })).toBeDisabled();
  });
});

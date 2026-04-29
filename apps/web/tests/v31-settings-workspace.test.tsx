/**
 * v3.1 Bug 6 — Settings → Workspace card.
 *
 * The page used to be a "Coming soon" placeholder with two disabled
 * inputs hard-coded to "Carve" / "image". This suite exercises the live
 * form wired to GET/PATCH /workspace:
 *
 *  1. Renders pre-filled name + description from the workspace query.
 *  2. As an admin, typing a new name + clicking "Save changes" calls
 *     ``workspaceApi.update`` with the dirty subset only.
 *  3. A 403 response surfaces "Only admins can edit the workspace" via
 *     the toast bus.
 *  4. Rendered as a non-admin, the fields are disabled and a read-only
 *     note is shown (no submit button).
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
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/settings/workspace" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

const adminUserState = {
  user: { id: "u1", email: "admin@example.com", role: "admin" as const },
  accessToken: "tok",
  refreshToken: "ref",
  setSession: vi.fn(),
  setAccessToken: vi.fn(),
  clear: vi.fn(),
};

const memberUserState = {
  ...adminUserState,
  user: { ...adminUserState.user, role: "member" as const },
};

let currentUserState: typeof adminUserState | typeof memberUserState =
  adminUserState;

vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) => selector(currentUserState),
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

vi.mock("@/api/workspace", () => ({
  workspaceApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

import { workspaceApi } from "@/api/workspace";
import { SettingsWorkspacePage } from "@/pages/SettingsPages";
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

const SAMPLE_WORKSPACE = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Carve",
  description: "Original description.",
  created_at: "2026-04-01T12:00:00Z",
  updated_at: "2026-04-15T12:00:00Z",
  members_count: 4,
};

afterEach(() => {
  cleanup();
  _resetToastBusForTests();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  currentUserState = adminUserState;
});

beforeEach(() => {
  vi.clearAllMocks();
  (workspaceApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(
    SAMPLE_WORKSPACE,
  );
});

describe("v3.1 — Settings Workspace card", () => {
  it("renders workspace name and description from the API and shows members_count", async () => {
    render(wrap(<SettingsWorkspacePage />));

    await waitFor(() => {
      const nameInput = screen.getByTestId(
        "workspace-name",
      ) as HTMLInputElement;
      expect(nameInput.value).toBe("Carve");
    });

    const descInput = screen.getByTestId(
      "workspace-description",
    ) as HTMLTextAreaElement;
    expect(descInput.value).toBe("Original description.");

    expect(screen.getByTestId("workspace-members-link")).toHaveTextContent(
      "4",
    );
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it("submits only the dirty fields with the trimmed name", async () => {
    (workspaceApi.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SAMPLE_WORKSPACE,
      name: "Acme Labs",
    });
    const events: string[] = [];
    const unsub = subscribeToasts((t) =>
      events.push(`${t.variant}:${t.message}`),
    );

    render(wrap(<SettingsWorkspacePage />));

    const nameInput = await screen.findByTestId("workspace-name");
    await waitFor(() =>
      expect((nameInput as HTMLInputElement).value).toBe("Carve"),
    );

    fireEvent.change(nameInput, { target: { value: "Acme Labs" } });

    const submit = screen.getByTestId(
      "workspace-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(workspaceApi.update).toHaveBeenCalledTimes(1);
    });
    expect(workspaceApi.update).toHaveBeenCalledWith({ name: "Acme Labs" });

    await waitFor(() => {
      expect(events).toContain("success:Workspace updated");
    });

    unsub();
  });

  it("disables submit when name is empty or unchanged", async () => {
    render(wrap(<SettingsWorkspacePage />));

    const nameInput = await screen.findByTestId("workspace-name");
    await waitFor(() =>
      expect((nameInput as HTMLInputElement).value).toBe("Carve"),
    );

    const submit = screen.getByTestId(
      "workspace-submit",
    ) as HTMLButtonElement;

    // Unchanged → disabled.
    expect(submit.disabled).toBe(true);

    // Empty → disabled.
    fireEvent.change(nameInput, { target: { value: "" } });
    expect(submit.disabled).toBe(true);
  });

  it("toasts a 403 with an admin-only message", async () => {
    const err = Object.assign(new Error("403"), {
      response: { status: 403 },
    });
    (workspaceApi.update as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const events: string[] = [];
    const unsub = subscribeToasts((t) =>
      events.push(`${t.variant}:${t.message}`),
    );

    render(wrap(<SettingsWorkspacePage />));

    const nameInput = await screen.findByTestId("workspace-name");
    await waitFor(() =>
      expect((nameInput as HTMLInputElement).value).toBe("Carve"),
    );
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("workspace-submit"));

    await waitFor(() => {
      expect(events).toContain("error:Only admins can edit the workspace");
    });

    unsub();
  });

  it("renders fields disabled and shows the readonly note for non-admins", async () => {
    currentUserState = memberUserState;

    render(wrap(<SettingsWorkspacePage />));

    const nameInput = (await screen.findByTestId(
      "workspace-name",
    )) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe("Carve"));
    expect(nameInput.disabled).toBe(true);

    const descInput = screen.getByTestId(
      "workspace-description",
    ) as HTMLTextAreaElement;
    expect(descInput.disabled).toBe(true);

    expect(screen.queryByTestId("workspace-submit")).toBeNull();
    expect(screen.getByTestId("workspace-readonly-note")).toHaveTextContent(
      /only admins can edit/i,
    );
  });
});

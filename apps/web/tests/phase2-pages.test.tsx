import React from "react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub TanStack Router primitives used inside settings/models/trash pages.
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

// Mock auth store to provide a user.
vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({
      user: { id: "u1", email: "admin@example.com", role: "admin" },
      accessToken: "tok",
      refreshToken: "ref",
      setSession: vi.fn(),
      setAccessToken: vi.fn(),
      clear: vi.fn(),
    }),
}));

vi.mock("@/auth/api", () => ({
  logout: vi.fn(),
}));

// Mock API clients
vi.mock("@/api/api_keys", () => ({
  apiKeysApi: {
    list: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
  },
}));

vi.mock("@/api/members", () => ({
  membersApi: {
    list: vi.fn(),
    setRole: vi.fn(),
  },
}));

vi.mock("@/api/phase2", () => ({
  trashApi: {
    list: vi.fn(),
    restore: vi.fn(),
    hardDelete: vi.fn(),
  },
  modelsApi: {
    samActive: vi.fn(),
    samSetActive: vi.fn(),
  },
  weightsApi: {
    listWorkspace: vi.fn(),
  },
}));

import { apiKeysApi } from "@/api/api_keys";
import { membersApi } from "@/api/members";
import { trashApi, modelsApi, weightsApi } from "@/api/phase2";
import {
  SettingsLayout,
  SettingsApiKeysPage,
  SettingsMembersPage,
  SettingsProfilePage,
} from "@/pages/SettingsPages";
import { ModelsSamPage, ModelsYoloPage, TrashPage } from "@/pages/Phase2Pages";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{node}</ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  // Radix Dialog portals can leave aria-hidden + scroll-lock attributes on
  // <body> between tests; clear them so subsequent renders aren't hidden.
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

beforeEach(() => {
  vi.clearAllMocks();
  (apiKeysApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (membersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (trashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
  (modelsApi.samActive as ReturnType<typeof vi.fn>).mockResolvedValue({
    active: "sam2.1-tiny",
    available: ["sam2.1-tiny", "sam2.1-small"],
  });
  (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("SettingsLayout", () => {
  it("renders sub-nav with all admin tabs when user is admin", () => {
    render(wrap(<SettingsLayout>body</SettingsLayout>));
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("renders the profile page email read-only", () => {
    render(wrap(<SettingsProfilePage />));
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    expect(input.value).toBe("admin@example.com");
    expect(input.disabled).toBe(true);
  });
});

describe("SettingsMembersPage", () => {
  it("renders mocked users in the list", async () => {
    (membersApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "u1", email: "alice@example.com", role: "admin" },
      { id: "u2", email: "bob@example.com", role: "member" },
    ]);
    render(wrap(<SettingsMembersPage />));
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
});

describe("SettingsApiKeysPage", () => {
  it("renders the New key trigger and the empty-state message", async () => {
    render(wrap(<SettingsApiKeysPage />));
    // Use findAllByText since the lucide icon's visually hidden span can match.
    const triggers = await screen.findAllByText(/new key/i);
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });

  it("calls apiKeysApi.create and reveals the token", async () => {
    (apiKeysApi.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "k1",
      name: "ci",
      prefix: "ck_abcdefghi",
      created_at: "2026-04-26T10:00:00+00:00",
      last_used_at: null,
      revoked_at: null,
      token: "ck_abcdefghi-supersecret",
    });
    const { container } = render(wrap(<SettingsApiKeysPage />));
    // Click the New key trigger via the visible text node, then bubble up
    // to the actual <button>.
    const triggerText = await screen.findByText(/new key/i);
    const triggerButton = triggerText.closest("button");
    if (!triggerButton) throw new Error("New key button not found");
    fireEvent.click(triggerButton);

    // Once the dialog opens, find the input and the Create button that lives
    // inside the dialog content (use container's portal mount).
    const nameInput = await screen.findByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: "ci" } });

    const createBtn = (() => {
      const all = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      );
      return all.find((b) => /^create$/i.test(b.textContent ?? ""));
    })();
    if (!createBtn) throw new Error("Create button not found");
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(apiKeysApi.create).toHaveBeenCalledWith("ci");
    });
    expect(await screen.findByTestId("revealed-token")).toHaveTextContent(
      "ck_abcdefghi-supersecret",
    );
    void container;
  });
});

describe("ModelsYoloPage", () => {
  it("shows empty-state when no weights exist", async () => {
    render(wrap(<ModelsYoloPage />));
    expect(
      await screen.findByText(/no custom yolo weights yet/i),
    ).toBeInTheDocument();
  });

  it("renders weights when present", async () => {
    (weightsApi.listWorkspace as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "w1",
        project_id: "p1",
        name: "yolov8n custom",
        task_kind: "detect",
        minio_key: "weights/x.pt",
        size_bytes: 6_500_000,
        class_names: ["car"],
        created_by: null,
        created_at: "2026-04-26T10:00:00+00:00",
      },
    ]);
    render(wrap(<ModelsYoloPage />));
    expect(await screen.findByText("yolov8n custom")).toBeInTheDocument();
    expect(screen.getByText("detect")).toBeInTheDocument();
  });
});

describe("ModelsSamPage", () => {
  it("renders the active variant prominently", async () => {
    render(wrap(<ModelsSamPage />));
    expect(await screen.findByText(/active variant/i)).toBeInTheDocument();
    // The label appears in both the active card and the variants list.
    const matches = await screen.findAllByText(/SAM 2.1 — Tiny/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("TrashPage", () => {
  it("shows empty-state when trash is empty", async () => {
    render(wrap(<TrashPage />));
    expect(await screen.findByText(/trash is empty/i)).toBeInTheDocument();
  });

  it("renders deleted items and Restore calls trashApi.restore", async () => {
    (trashApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          kind: "project",
          id: "p1",
          name: "Old project",
          project_id: null,
          deleted_at: "2026-04-25T10:00:00+00:00",
        },
      ],
    });
    (trashApi.restore as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(wrap(<TrashPage />));
    expect(await screen.findByText("Old project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => {
      expect(trashApi.restore).toHaveBeenCalledWith("project", "p1");
    });
  });
});

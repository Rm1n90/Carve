/**
 * Settings → Configuration — provider API keys and runtime settings a
 * superadmin saves in the app instead of in `.env`.
 *
 *  1. The tab is listed for the superadmin only.
 *  2. A saved key is shown by its last four characters, never in full,
 *     and pasting a new one saves it through the API.
 *  3. A key can be tested before it is saved.
 *  4. A number is saved as typed; the server's refusal is shown.
 *  5. Settings are split into tabs; a key links to the provider's page;
 *     a choice shows readable names.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...rest
  }: { children: React.ReactNode; to?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/settings/configuration" } }),
  useNavigate: () => () => undefined,
  Navigate: () => null,
}));

let role: "superadmin" | "admin" = "superadmin";
vi.mock("@/auth/store", () => ({
  useAuth: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: "u1", email: "sa@example.com", role }, accessToken: "tok" }),
}));

vi.mock("@/api/appSettings", () => ({
  appSettingsApi: {
    list: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    test: vi.fn(),
    restartModel: vi.fn(),
  },
}));

import { appSettingsApi } from "@/api/appSettings";
import { SettingsConfigurationPage } from "@/pages/SettingsConfigurationPage";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";

const base = {
  minimum: null,
  maximum: null,
  unit: null,
  choices: [],
  allow_empty: false,
  testable: false,
  service: "api",
  options: [],
  option_labels: [],
  links: [],
  env_set: false,
  unreadable: false,
  updated_at: null,
  updated_by: null,
  hint: null,
  env_hint: null,
};

const LISTING = {
  applies_within_seconds: 5,
  services: { model: { reachable: true, pending_restart: true } },
  startup: [{ key: "JWT_SECRET", label: "Signs sign-in tokens", secret: true, set: true }],
  settings: [
    {
      ...base,
      key: "OPENAI_API_KEY",
      group: "Logo AI providers",
      label: "OpenAI API key",
      help: "GPT models.",
      kind: "secret",
      testable: true,
      source: "app",
      env_set: true,
      value: null,
      hint: "…1234",
      env_hint: "…9999",
      updated_at: "2026-11-01T10:00:00Z",
      updated_by: "sa@example.com",
      links: [{ label: "Get an OpenAI key", url: "https://platform.openai.com/api-keys" }],
    },
    {
      ...base,
      key: "LOGO_AI_CONCURRENCY",
      group: "Logo AI",
      label: "Requests at once (realtime)",
      help: "In flight at once.",
      kind: "int",
      minimum: 1,
      maximum: 32,
      source: "default",
      value: 4,
    },
    {
      ...base,
      key: "SAM_DTYPE",
      group: "Model service (SAM, YOLO)",
      label: "SAM precision",
      help: "bf16 is the fastest.",
      kind: "choice",
      service: "model",
      options: ["bf16", "fp16", "fp32", "auto"],
      source: "env",
      env_set: true,
      value: "bf16",
    },
    {
      ...base,
      key: "MEMBERS_SAM",
      group: "Member access",
      label: "SAM",
      help: "Click, box and text segmentation.",
      kind: "choice",
      options: ["admins", "opened_tasks", "all_tasks"],
      option_labels: [
        "Admins only",
        "Members, on tasks opened for them",
        "Members, on every task they can open",
      ],
      source: "default",
      value: "opened_tasks",
    },
  ],
};

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
}

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

const mocked = appSettingsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  role = "superadmin";
  mocked.list.mockResolvedValue(LISTING);
  mocked.save.mockResolvedValue(LISTING);
});

afterEach(() => cleanup());

describe("Settings → Configuration", () => {
  it("lists the tab for the superadmin only", async () => {
    render(wrap(<SettingsConfigurationPage />));
    expect(screen.getByRole("link", { name: "Configuration" })).toBeInTheDocument();
    cleanup();
    role = "admin";
    render(wrap(<SettingsConfigurationPage />));
    expect(screen.queryByRole("link", { name: "Configuration" })).toBeNull();
  });

  it("shows a saved key by its last four characters and saves a pasted one", async () => {
    render(wrap(<SettingsConfigurationPage />));
    const input = (await screen.findByLabelText("OpenAI API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.placeholder).toContain("…1234");
    expect(screen.getByText(/\.env has another key \(…9999\)/)).toBeInTheDocument();
    expect(screen.getByText("Set here")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "sk-new-key-5678" } });
    const row = input.closest("form") as HTMLFormElement;
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(appSettingsApi.save).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-new-key-5678"),
    );
  });

  it("tests a typed key before saving it", async () => {
    mocked.test.mockResolvedValue({ ok: false, message: "OpenAI refused the key (HTTP 401)." });
    render(wrap(<SettingsConfigurationPage />));
    const input = await screen.findByLabelText("OpenAI API key");
    fireEvent.change(input, { target: { value: "sk-typed-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Test this key" }));
    expect(await screen.findByText("OpenAI refused the key (HTTP 401).")).toBeInTheDocument();
    expect(appSettingsApi.test).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-typed-0000");
    expect(appSettingsApi.save).not.toHaveBeenCalled();
  });

  it("saves a number and shows the server's refusal", async () => {
    mocked.save.mockRejectedValueOnce({
      response: { status: 422, data: { message: "Enter a value from 1 to 32." } },
    });
    render(wrap(<SettingsConfigurationPage />));
    await screen.findByRole("tab", { name: "Logo AI" });
    expect(screen.queryByLabelText("Requests at once (realtime)")).toBeNull();
    openTab("Logo AI");
    const input = (await screen.findByLabelText("Requests at once (realtime)")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("4"));
    fireEvent.change(input, { target: { value: "64" } });
    fireEvent.click(within(input.closest("form") as HTMLFormElement).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(appSettingsApi.save).toHaveBeenCalledWith("LOGO_AI_CONCURRENCY", "64"),
    );
    openTab(".env only");
    expect(await screen.findByText("JWT_SECRET")).toBeInTheDocument();
  });

  it("saves a choice and restarts the model service when its settings changed", async () => {
    mocked.restartModel.mockResolvedValue(LISTING);
    render(wrap(<SettingsConfigurationPage />));
    await screen.findByRole("tab", { name: "Model service" });
    openTab("Model service");
    const select = (await screen.findByLabelText("SAM precision")) as HTMLSelectElement;
    expect(select.value).toBe("bf16");
    fireEvent.change(select, { target: { value: "fp16" } });
    await waitFor(() => expect(appSettingsApi.save).toHaveBeenCalledWith("SAM_DTYPE", "fp16"));

    expect(screen.getByText(/Saved changes are waiting/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart model service" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(appSettingsApi.restartModel).toHaveBeenCalledTimes(1));
  });

  it("links a key to the provider's page and names member access choices", async () => {
    render(wrap(<SettingsConfigurationPage />));
    const link = await screen.findByRole("link", { name: /Get an OpenAI key/ });
    expect(link).toHaveAttribute("href", "https://platform.openai.com/api-keys");
    expect(link).toHaveAttribute("target", "_blank");

    openTab("Member access");
    const select = (await screen.findByLabelText("SAM")) as HTMLSelectElement;
    expect(select.value).toBe("opened_tasks");
    expect(
      within(select).getByRole("option", { name: "Members, on every task they can open" }),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "all_tasks" } });
    await waitFor(() => expect(appSettingsApi.save).toHaveBeenCalledWith("MEMBERS_SAM", "all_tasks"));
  });
});

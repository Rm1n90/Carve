import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FirstRunWizard } from "@/pages/FirstRunWizard";

vi.mock("@/auth/api", () => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  bootstrapStatus: vi.fn(),
}));

import * as authApi from "@/auth/api";

describe("FirstRunWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the wizard heading", () => {
    render(<FirstRunWizard onSuccess={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /set up your admin account/i }),
    ).toBeInTheDocument();
  });

  it("disables submit until passwords match", () => {
    render(<FirstRunWizard onSuccess={() => {}} />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "hunter22" },
    });
    fireEvent.change(screen.getByLabelText(/confirm/i), {
      target: { value: "different-value" },
    });

    const submit = screen.getByRole("button", { name: /create admin/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/confirm/i), {
      target: { value: "hunter22" },
    });
    expect(submit).toBeEnabled();
  });

  it("calls register then login on submit", async () => {
    (authApi.register as any).mockResolvedValue({
      id: "1",
      email: "admin@example.com",
      role: "admin",
    });
    (authApi.login as any).mockResolvedValue(undefined);

    render(<FirstRunWizard onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "hunter22" },
    });
    fireEvent.change(screen.getByLabelText(/confirm/i), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create admin/i }));

    await waitFor(() => {
      expect(authApi.register).toHaveBeenCalledWith(
        "admin@example.com",
        "hunter22",
      );
    });
    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith(
        "admin@example.com",
        "hunter22",
      );
    });
  });
});

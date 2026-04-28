import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/auth/api", () => ({
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { LoginPage } from "@/auth/LoginPage";
import * as authApi from "@/auth/api";

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits credentials", async () => {
    (authApi.login as any).mockResolvedValue(undefined);
    render(<LoginPage onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "u@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "hunter22" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(authApi.login).toHaveBeenCalledWith("u@example.com", "hunter22");
    });
  });

  it("shows error on rejection", async () => {
    (authApi.login as any).mockRejectedValue({
      response: { data: { error: "invalid_credentials" } },
    });
    render(<LoginPage onSuccess={() => {}} />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "u@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/invalid/i)).toBeInTheDocument();
  });

  it("renders the editorial v2.9 chrome (wordmark, glass card, font-editorial title)", () => {
    render(<LoginPage onSuccess={() => {}} />);
    // CarveMark wordmark (rendered as the editorial italic "Carve" text).
    expect(screen.getByText("Carve")).toBeInTheDocument();
    // Title uses font-editorial italic.
    const title = screen.getByTestId("auth-card-title");
    expect(title.className).toContain("font-editorial");
    expect(title.textContent).toMatch(/sign in to carve/i);
    // Card surface uses the v2.8 glass utility.
    const card = title.closest('[class*="glass-surface-strong"]');
    expect(card).not.toBeNull();
    // Eyebrow is rendered.
    expect(screen.getByTestId("auth-eyebrow")).toHaveTextContent(/sign in/i);
  });
});

import { useState } from "react";
import { login, register } from "@/auth/api";

interface Props {
  onSuccess: () => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export function FirstRunWizard({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const emailValid = EMAIL_REGEX.test(email);
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const confirmMatches = confirm === password && confirm.length > 0;
  const canSubmit = emailValid && passwordValid && confirmMatches && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      await register(email, password);
      await login(email, password);
      onSuccess();
    } catch (err: any) {
      const code = err?.response?.data?.error ?? "unknown_error";
      setError(
        code === "email_taken" ? "That email is already registered." : code,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        maxWidth: 420,
        margin: "8vh auto",
        display: "grid",
        gap: 16,
        padding: 24,
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
      }}
    >
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>
          Welcome — set up your admin account
        </h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 14 }}>
          This is the first user of this VisualAutoAnnotator instance and will
          have full administrative privileges.
        </p>
      </header>
      <label style={{ display: "grid", gap: 4 }}>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        Password (min {MIN_PASSWORD_LENGTH})
        <input
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <label style={{ display: "grid", gap: 4 }}>
        Confirm password
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      {confirm.length > 0 && !confirmMatches && (
        <div role="status" style={{ color: "tomato", fontSize: 13 }}>
          Passwords do not match.
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: "tomato" }}>
          {error}
        </div>
      )}
      <button type="submit" disabled={!canSubmit}>
        {busy ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}

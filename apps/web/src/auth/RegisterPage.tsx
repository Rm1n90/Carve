import { useState } from "react";
import { login, register } from "./api";

interface Props {
  onSuccess: () => void;
}

export function RegisterPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password);
      await login(email, password);
      onSuccess();
    } catch (err: any) {
      const code = err?.response?.data?.error ?? "unknown_error";
      setError(code === "email_taken" ? "That email is already registered." : code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ maxWidth: 360, margin: "8vh auto", display: "grid", gap: 12 }}>
      <h1>Create account</h1>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password (min 8)
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <div role="alert" style={{ color: "tomato" }}>
          {error}
        </div>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}

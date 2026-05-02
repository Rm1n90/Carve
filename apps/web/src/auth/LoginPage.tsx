// Armin Mehri — mehri.armin@gmail.com
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { login } from "./api";

interface Props {
  onSuccess: () => void;
}

export function LoginPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      onSuccess();
    } catch (err: unknown) {
      const code =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "unknown_error";
      setError(code === "invalid_credentials" ? "Invalid email or password." : code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Sign in"
      cardTitle="Sign in to Carve"
      cardDescription="Welcome back."
      cardFooter={
        <span>
          Need an account?{" "}
          <Link
            to="/register"
            className="text-[color:var(--accent)] hover:text-[color:var(--accent-hover)] font-medium"
          >
            Register
          </Link>
        </span>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-3" noValidate>
        <Input
          label="Email"
          type="email"
          required
          autoComplete="username"
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[color:var(--danger)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? "Signing in" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}

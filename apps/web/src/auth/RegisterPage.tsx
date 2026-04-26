import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, AlertCircle } from "lucide-react";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { login, register } from "./api";

interface Props {
  onSuccess: () => void;
}

export function RegisterPage({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(email, password);
      await login(email, password);
      onSuccess();
    } catch (err: unknown) {
      const code =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "unknown_error";
      setError(code === "email_taken" ? "That email is already registered." : code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      headline={
        <>
          New work,
          <br />
          new corpus.
        </>
      }
      subtitle="Create an account to start carving labels into your dataset."
      cardTitle="Create account"
      cardDescription="It takes about ten seconds."
      cardFooter={
        <span>
          Have an account?{" "}
          <Link
            to="/login"
            className="text-[var(--accent)] hover:text-[var(--accent-hover)] tracking-tight font-medium"
          >
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <Input
          label="Email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="Min 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[oklch(0.70_0.20_25_/_0.40)] bg-[oklch(0.70_0.20_25_/_0.08)] px-3 py-2 text-[13px] text-[var(--danger)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={busy}
          rightIcon={!busy && <ArrowRight className="h-4 w-4" />}
        >
          {busy ? "Creating" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}

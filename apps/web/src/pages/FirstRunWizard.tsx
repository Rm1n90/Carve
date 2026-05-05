import { useState, type FormEvent } from "react";
import { AlertCircle, ShieldCheck, Layers, Sparkles } from "lucide-react";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
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

  const setupItems = [
    { icon: ShieldCheck, label: "Admin" },
    { icon: Layers, label: "Projects" },
    { icon: Sparkles, label: "AI" },
  ] as const;

  return (
    <AuthShell
      maxWidth={480}
      cardTitle="Welcome to Carve"
      cardDescription="Create your first administrator account."
      topInline={
        <ul className="mb-5 flex items-center gap-4 text-[12px] text-[color:var(--text-tertiary)]">
          {setupItems.map((it) => (
            <li key={it.label} className="flex items-center gap-1.5">
              <it.icon className="h-3.5 w-3.5 text-[color:var(--accent)]" aria-hidden />
              <span>{it.label}</span>
            </li>
          ))}
        </ul>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-3" noValidate>
        <Input
          label="Email"
          type="email"
          required
          autoComplete="username"
          placeholder="admin@studio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label={`Password (min ${MIN_PASSWORD_LENGTH})`}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          label="Confirm password"
          type="password"
          required
          autoComplete="new-password"
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm.length > 0 && !confirmMatches ? "Passwords do not match." : undefined}
        />
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-3)] border border-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[color:var(--danger)]"
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
          disabled={!canSubmit}
          loading={busy}
        >
          {busy ? "Creating" : "Create admin account"}
        </Button>
      </form>
    </AuthShell>
  );
}

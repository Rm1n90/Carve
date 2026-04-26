import { useState, type FormEvent } from "react";
import { ArrowRight, AlertCircle, ShieldCheck, Layers, Sparkles } from "lucide-react";
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
    { icon: ShieldCheck, label: "Admin account", hint: "Full administrative privileges." },
    { icon: Layers, label: "Projects & users", hint: "Carve workspaces, members, roles." },
    { icon: Sparkles, label: "Annotation pipeline", hint: "Bbox · polygon · mask · SAM tracking." },
  ] as const;

  return (
    <AuthShell
      headline={
        <>
          Welcome to
          <br />
          Carve.
        </>
      }
      subtitle="One last step before you start carving labels — your dataset, your hardware, your call."
      leftMeta={
        <div className="grid gap-3 mt-4">
          <div className="font-mono-data text-[10px] tracking-[0.20em] uppercase text-tertiary">
            Step 1 of 1 — what you're about to set up
          </div>
          <ul className="grid gap-2.5">
            {setupItems.map((item) => (
              <li
                key={item.label}
                className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[oklch(0.18_0.012_240_/_0.45)] backdrop-blur-sm p-3"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent-bg)] text-[var(--accent)]">
                  <item.icon className="h-4 w-4" />
                </span>
                <div className="grid">
                  <span className="text-[13px] font-medium text-primary tracking-tight">
                    {item.label}
                  </span>
                  <span className="text-[12px] text-tertiary">{item.hint}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      }
      cardTitle="Set up your admin account"
      cardDescription="This is the first user of this Carve instance and will have full administrative privileges."
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
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
          disabled={!canSubmit}
          loading={busy}
          rightIcon={!busy && <ArrowRight className="h-4 w-4" />}
        >
          {busy ? "Creating" : "Create admin account"}
        </Button>
      </form>
    </AuthShell>
  );
}

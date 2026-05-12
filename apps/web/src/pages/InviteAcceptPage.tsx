// Armin Mehri — mehri.armin@gmail.com
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle } from "lucide-react";
import { AuthShell } from "@/components/layout/AuthShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  invitesApi,
  type InviteAcceptResult,
  type InvitePreview,
} from "@/api/invites";
import { login as authLogin } from "@/auth/api";
import { useAuth } from "@/auth/store";
import { showToast } from "@/lib/toast";

interface InviteAcceptPageProps {
  token: string;
  onAccepted: (result: InviteAcceptResult) => void;
}

interface ErrorBody {
  error?: string;
}

function pickFriendly(status: number | undefined, body: ErrorBody): string {
  switch (status) {
    case 410:
      return "This invitation has expired. Ask the project owner to send a new one.";
    case 409:
      if (body.error === "invite_already_accepted") {
        return "This invitation has already been used.";
      }
      return "This invitation can no longer be accepted.";
    case 403:
      return "Sign in with the email this invitation was sent to.";
    case 404:
      return "Invitation not found.";
    case 401:
      return "Please sign in to continue.";
    default:
      return "Could not accept the invitation. Please try again.";
  }
}

function readError(err: unknown): { status?: number; body: ErrorBody } {
  const e = err as {
    response?: { status?: number; data?: ErrorBody | string };
  };
  const data = e?.response?.data;
  const body: ErrorBody =
    typeof data === "object" && data !== null ? (data as ErrorBody) : {};
  return { status: e?.response?.status, body };
}

export function InviteAcceptPage({ token, onAccepted }: InviteAcceptPageProps) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [loginPassword, setLoginPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // Current auth state — when the user clicking the invite link is
  // already signed in (typical case: the inviter testing their own
  // invite, or a returning user with a live session) we branch on
  // whether the session matches the invite target.
  const currentUser = useAuth((s) => s.user);
  const currentToken = useAuth((s) => s.accessToken);
  const isAuthed = !!currentToken && !!currentUser;

  useEffect(() => {
    let cancelled = false;
    invitesApi
      .preview(token)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const { status, body } = readError(err);
        setLoadError(pickFriendly(status, body));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loadError !== null) {
    return (
      <AuthShell
        eyebrow="Invitation"
        cardTitle="Can't accept this invitation"
        cardDescription={loadError}
      >
        <div data-testid="invite-load-error" className="text-[13px]">
          {loadError}
        </div>
      </AuthShell>
    );
  }

  if (preview === null) {
    return (
      <AuthShell eyebrow="Invitation" cardTitle="Loading invitation…">
        <p className="text-[13px] text-[color:var(--text-tertiary)]">
          Verifying your invitation token.
        </p>
      </AuthShell>
    );
  }

  async function onExistingSubmit(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await authLogin(preview.email, loginPassword);
      const result = await invitesApi.accept({ token });
      showToast(`Joined ${preview.project_name}`, { variant: "success" });
      onAccepted(result);
    } catch (err: unknown) {
      const { status, body } = readError(err);
      if (status === 401 && body.error === "invalid_credentials") {
        setSubmitError("Wrong password. Try again.");
      } else {
        setSubmitError(pickFriendly(status, body));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onRegisterSubmit(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setSubmitError("Passwords don't match.");
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await invitesApi.accept({ token, password });
      if (result.jwt && result.refresh_token) {
        useAuth.getState().setSession({
          accessToken: result.jwt,
          refreshToken: result.refresh_token,
          user: {
            id: result.user.id,
            email: result.user.email,
            role:
              (result.user.role as "admin" | "member" | "viewer") ?? "member",
          },
        });
      }
      showToast(`Welcome to ${preview.project_name}`, { variant: "success" });
      onAccepted(result);
    } catch (err: unknown) {
      const { status, body } = readError(err);
      setSubmitError(pickFriendly(status, body));
    } finally {
      setSubmitting(false);
    }
  }

  async function onAcceptAsCurrentUser() {
    if (!preview) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await invitesApi.accept({ token });
      showToast(`Joined ${preview.project_name}`, { variant: "success" });
      onAccepted(result);
    } catch (err: unknown) {
      const { status, body } = readError(err);
      setSubmitError(pickFriendly(status, body));
    } finally {
      setSubmitting(false);
    }
  }

  function onSwitchAccount() {
    useAuth.getState().clear();
    // Reload the page so the in-flight auth-aware components reset
    // and the unauthed login form renders cleanly. The token in the
    // URL is preserved.
    if (typeof window !== "undefined") window.location.reload();
  }

  const sameEmail =
    isAuthed &&
    currentUser?.email?.toLowerCase() === preview.email.toLowerCase();
  const wrongEmail = isAuthed && !sameEmail;

  const title = `Join ${preview.project_name}`;
  const description = sameEmail
    ? `You're signed in as ${preview.email}. Accept the invitation to join as ${preview.role}.`
    : wrongEmail
      ? `This invitation was sent to ${preview.email}, but you're signed in as ${currentUser?.email}.`
      : preview.requires_password
        ? `Create an account for ${preview.email} to accept this invitation.`
        : `Sign in as ${preview.email} to accept this invitation.`;

  return (
    <AuthShell
      eyebrow="Invitation"
      cardTitle={title}
      cardDescription={description}
    >
      {sameEmail ? (
        <div className="grid gap-3">
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-3)] border border-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[color:var(--danger)]"
              data-testid="invite-submit-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{submitError}</span>
            </div>
          )}
          <Button
            type="button"
            variant="primary"
            size="lg"
            block
            loading={submitting}
            onClick={onAcceptAsCurrentUser}
            data-testid="invite-accept-current"
          >
            {submitting ? "Joining" : `Accept invitation as ${preview.role}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            block
            onClick={onSwitchAccount}
            data-testid="invite-switch-account"
          >
            Use a different account
          </Button>
        </div>
      ) : wrongEmail ? (
        <div className="grid gap-3">
          <p className="text-[13px] text-[color:var(--text-secondary)]">
            To accept this invitation, sign out of {currentUser?.email} and
            sign back in as {preview.email}.
          </p>
          <Button
            type="button"
            variant="primary"
            size="lg"
            block
            onClick={onSwitchAccount}
            data-testid="invite-switch-account"
          >
            Sign out and switch account
          </Button>
        </div>
      ) : preview.requires_password ? (
        <form onSubmit={onRegisterSubmit} className="grid gap-3" noValidate>
          <Input
            label="Email"
            type="email"
            value={preview.email}
            readOnly
            data-testid="invite-email"
          />
          <Input
            label="Password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="invite-password"
          />
          <Input
            label="Confirm password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="invite-confirm"
          />
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-3)] border border-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[color:var(--danger)]"
              data-testid="invite-submit-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{submitError}</span>
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={submitting}
            data-testid="invite-register-submit"
          >
            {submitting ? "Joining" : `Join as ${preview.role}`}
          </Button>
        </form>
      ) : (
        <form onSubmit={onExistingSubmit} className="grid gap-3" noValidate>
          <Input
            label="Email"
            type="email"
            value={preview.email}
            readOnly
            data-testid="invite-email"
          />
          <Input
            label="Password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            data-testid="invite-login-password"
          />
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[var(--radius-3)] border border-[var(--danger)] bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[color:var(--danger)]"
              data-testid="invite-submit-error"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{submitError}</span>
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={submitting}
            data-testid="invite-login-submit"
          >
            {submitting ? "Joining" : `Sign in & join as ${preview.role}`}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

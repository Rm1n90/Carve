// Armin Mehri — mehri.armin@gmail.com
//
// What a page that fails to render shows instead of an empty screen:
// what went wrong, a way out (reload, which also picks up a new build),
// and the details to send on. The router shows it for any route's
// error; ``AppErrorBoundary`` catches what fails above the router.
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@/components/ui/Button";

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

export function errorDetails(error: unknown, componentStack?: string | null): string {
  return [
    `Page: ${window.location.pathname}${window.location.search}`,
    `Time: ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    "",
    describe(error),
    componentStack ? `\nComponents:${componentStack}` : "",
  ].join("\n");
}

interface ErrorScreenProps {
  error: unknown;
  componentStack?: string | null;
}

export function ErrorScreen({ error, componentStack }: ErrorScreenProps) {
  const [copied, setCopied] = useState(false);
  const message = error instanceof Error ? error.message : String(error);
  const details = errorDetails(error, componentStack);
  return (
    <div
      role="alert"
      data-testid="route-error"
      className="min-h-screen grid place-items-center bg-[var(--bg-app)] p-6"
    >
      <div className="grid w-[min(92vw,640px)] gap-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elev)] p-6">
        <div className="grid gap-1">
          <h1 className="text-[17px] font-medium text-[color:var(--text-primary)]">
            This page stopped working
          </h1>
          <p className="text-[13px] text-[color:var(--text-secondary)]">
            Nothing you saved is lost. Reload to carry on; if it happens
            again, copy the details below and send them on.
          </p>
        </div>
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--bg-sunken)] p-3 font-mono-data text-[11.5px] text-[color:var(--text-secondary)]">
          {message}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="md"
            data-testid="route-error-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(details).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy details"}
          </Button>
          <Button
            variant="primary"
            size="md"
            data-testid="route-error-reload"
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The router's error component for every route. */
export function RouteError({ error, info }: ErrorComponentProps) {
  return <ErrorScreen error={error} componentStack={info?.componentStack} />;
}

/** Logs a route's error with where it happened; the screen shows it. */
export function logRouteError(error: Error, info?: ErrorInfo): void {
  console.error("[carve] page error", error, info?.componentStack ?? "");
}

interface BoundaryState {
  error: unknown;
  componentStack: string | null;
}

/** For a failure above the router, which no route can catch. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    logRouteError(error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <ErrorScreen error={this.state.error} componentStack={this.state.componentStack} />;
    }
    return this.props.children;
  }
}

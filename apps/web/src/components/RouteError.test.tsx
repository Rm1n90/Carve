// Armin Mehri — mehri.armin@gmail.com
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppErrorBoundary, RouteError, errorDetails } from "./RouteError";

function Broken(): never {
  throw new Error("Cannot read properties of undefined (reading 'pages')");
}

afterEach(() => vi.restoreAllMocks());

describe("RouteError", () => {
  it("says what went wrong and offers a reload", () => {
    render(
      <RouteError
        error={new Error("Invariant failed: Could not find an active match")}
        reset={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("This page stopped working");
    expect(screen.getByText("Invariant failed: Could not find an active match")).toBeTruthy();
    expect(screen.getByTestId("route-error-reload")).toBeTruthy();
  });

  it("copies the details to send on", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RouteError error={new Error("boom")} info={{ componentStack: "\n    at AssetGrid" }} reset={() => {}} />);
    fireEvent.click(screen.getByTestId("route-error-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    const sent = writeText.mock.calls[0][0] as string;
    expect(sent).toContain("boom");
    expect(sent).toContain("at AssetGrid");
    expect(sent).toContain(`Page: ${window.location.pathname}`);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

describe("AppErrorBoundary", () => {
  it("shows the error screen for a failure above the router", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("route-error")).toBeTruthy();
    expect(screen.getByText("Cannot read properties of undefined (reading 'pages')")).toBeTruthy();
  });

  it("renders its children when nothing fails", () => {
    render(
      <AppErrorBoundary>
        <p>Projects</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Projects")).toBeTruthy();
  });
});

describe("errorDetails", () => {
  it("holds a non-Error value too", () => {
    expect(errorDetails("plain string")).toContain("plain string");
  });
});

import * as React from "react";

export type LogoVariant = "mark" | "full" | "stacked";

interface LogoProps {
  variant?: LogoVariant;
  /** Mark height in px. For `full` and `stacked`, the wordmark scales with this. */
  size?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Carve brand logo — inline SVG that inherits text colour via `currentColor`
 * for both stroke and fill, so it works on any backdrop.
 *
 * Concept: a square frame with a polygon vertex carved into the top-right
 * corner — a literal nod to the segmentation work the product does. The
 * filled dot at the carve vertex represents the active vertex you are
 * sculpting.
 *
 * Variants:
 *  - `mark`     — the 24×24 mark only (compact UI / favicon).
 *  - `full`     — mark + "Carve" wordmark on a single row (TopBar).
 *  - `stacked`  — mark above the wordmark (login / splash hero).
 */
export function Logo({
  variant = "full",
  size = 24,
  className,
  ariaLabel = "Carve — VisualAutoAnnotator",
}: LogoProps) {
  const wordmarkFontSize = Math.round(size * 1.05);

  const markSvg = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden={variant !== "mark"}
      role={variant === "mark" ? "img" : undefined}
      aria-label={variant === "mark" ? ariaLabel : undefined}
    >
      <path d="M3 3H16L12 9L21 8V21H3Z" />
      <circle cx={12} cy={9} r={1.4} fill="currentColor" stroke="none" />
    </svg>
  );

  const wordmark = (
    <span
      aria-hidden
      style={{
        fontFamily: "Fraunces, 'Instrument Serif', serif",
        fontStyle: "italic",
        fontWeight: 500,
        fontSize: `${wordmarkFontSize}px`,
        lineHeight: 1,
        letterSpacing: "-0.01em",
        color: "currentColor",
      }}
    >
      Car<span style={{ letterSpacing: "-0.02em" }}>v</span>e
    </span>
  );

  if (variant === "mark") {
    return React.cloneElement(markSvg, {
      "data-testid": "brand-logo",
      className,
    });
  }

  if (variant === "stacked") {
    return (
      <span
        data-testid="brand-logo"
        role="img"
        aria-label={ariaLabel}
        className={className}
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: size * 0.25,
        }}
      >
        {markSvg}
        {wordmark}
      </span>
    );
  }

  return (
    <span
      data-testid="brand-logo"
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.4 }}
    >
      {markSvg}
      {wordmark}
    </span>
  );
}

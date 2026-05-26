// Armin Mehri — mehri.armin@gmail.com
/**
 * v3.3 Issue 2 — tiny relative-time formatter.
 *
 * Returns "2 days ago", "3 weeks ago", "5 minutes ago", etc., for an
 * ISO-8601 string emitted by the API. Falls back to a locale date for
 * anything older than ~1 year. Returns "—" for unparseable input so we
 * never render "Invalid Date" in the UI.
 *
 * No external dependency: the project does NOT ship `date-fns`. The
 * audit explicitly allowed an inline formatter when that's the case.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  const now = Date.now();
  const diff = now - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;

  const fmt = (n: number, unit: string) => {
    const plural = n === 1 ? unit : `${unit}s`;
    return future ? `in ${n} ${plural}` : `${n} ${plural} ago`;
  };

  if (abs < MINUTE) return future ? "in a moment" : "just now";
  if (abs < HOUR) return fmt(Math.round(abs / MINUTE), "minute");
  if (abs < DAY) return fmt(Math.round(abs / HOUR), "hour");
  if (abs < WEEK) return fmt(Math.round(abs / DAY), "day");
  if (abs < MONTH) return fmt(Math.round(abs / WEEK), "week");
  if (abs < YEAR) return fmt(Math.round(abs / MONTH), "month");

  // Older than ~1 year: prefer an unambiguous absolute date.
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Format an ISO-8601 timestamp as a relative phrase like
 * "moments ago", "30 minutes ago", "yesterday", "6 days ago".
 *
 * @param iso  past timestamp, or null (returns empty string)
 * @param now  optional reference time in ms — for deterministic tests
 */
export function formatRelativeTime(
  iso: string | null,
  now: number = Date.now(),
): string {
  if (iso === null) return "";
  const past = new Date(iso).getTime();
  const diff = now - past;
  if (diff < MINUTE) return "moments ago";
  if (diff < HOUR) return formatter.format(-Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return formatter.format(-Math.floor(diff / HOUR), "hour");
  return formatter.format(-Math.floor(diff / DAY), "day");
}

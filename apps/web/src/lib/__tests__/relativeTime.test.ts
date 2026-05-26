import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../relativeTime";

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-26T12:00:00Z").getTime();

  it("returns 'moments ago' under 60 seconds", () => {
    const past = new Date("2026-05-26T11:59:30Z").toISOString();
    expect(formatRelativeTime(past, now)).toBe("moments ago");
  });

  it("returns minutes for under an hour", () => {
    const past = new Date("2026-05-26T11:30:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/30 minutes ago|half an hour ago/);
  });

  it("returns hours for under a day", () => {
    const past = new Date("2026-05-26T06:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/6 hours ago/);
  });

  it("returns 'yesterday' for 24-48h", () => {
    const past = new Date("2026-05-25T12:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/yesterday|1 day ago/);
  });

  it("returns days for longer ranges", () => {
    const past = new Date("2026-05-20T12:00:00Z").toISOString();
    expect(formatRelativeTime(past, now)).toMatch(/6 days ago/);
  });

  it("returns empty string for null input", () => {
    expect(formatRelativeTime(null, now)).toBe("");
  });
});

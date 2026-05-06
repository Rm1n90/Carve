import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { matchChord } from "../src/lib/shortcuts/chord";

function makeKey(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, ...opts });
}

describe("matchChord — dialog suppression (v3.24.2)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches plain chord when no dialog is open", () => {
    expect(matchChord(makeKey("ArrowLeft"), "arrowleft")).toBe(true);
  });

  it("suppresses chord when a Radix dialog is open (data-state=open)", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    expect(matchChord(makeKey("ArrowLeft"), "arrowleft")).toBe(false);
  });

  it("suppresses chord when an alertdialog is open", () => {
    const ad = document.createElement("div");
    ad.setAttribute("role", "alertdialog");
    ad.setAttribute("data-state", "open");
    document.body.appendChild(ad);
    expect(matchChord(makeKey("ArrowRight"), "arrowright")).toBe(false);
  });

  it("does NOT suppress when role=dialog but data-state=closed", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "closed");
    document.body.appendChild(dialog);
    expect(matchChord(makeKey("ArrowLeft"), "arrowleft")).toBe(true);
  });

  it("does NOT suppress when there's only a popover (role=tooltip etc)", () => {
    const popover = document.createElement("div");
    popover.setAttribute("role", "tooltip");
    popover.setAttribute("data-state", "open");
    document.body.appendChild(popover);
    expect(matchChord(makeKey("ArrowLeft"), "arrowleft")).toBe(true);
  });

  it("modifier chord is also suppressed (Cmd+S etc) when dialog open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true });
    expect(matchChord(e, "mod+s")).toBe(false);
  });
});

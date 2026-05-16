/**
 * Cheat-sheet hotkey predicate — regression test for the
 * "Shift+7 opens the cheat sheet on German QWERTZ" bug.
 *
 * On German layouts Shift+7 produces ``e.key === "/"`` (the slash
 * character), which previously matched the legacy ``Shift+/`` fallback
 * and opened the keyboard cheat-sheet just as the user was trying to
 * bind class digit 7. The predicate must:
 *
 *   - open on a genuine ``?`` (any layout that puts ``?`` in e.key)
 *   - open on Shift+physical-slash (US Shift+/)
 *   - NEVER open on physical Digit1..9 / Numpad1..9, regardless of
 *     what e.key happens to be on the user's layout
 */
import { describe, expect, it } from "vitest";
import { shouldOpenCheatSheet } from "@/lib/cheat-sheet-hotkey";

describe("shouldOpenCheatSheet", () => {
  it("opens on US Shift+/ (e.key='?', e.code='Slash')", () => {
    expect(shouldOpenCheatSheet({
      key: "?", code: "Slash", shiftKey: true,
    })).toBe(true);
  });

  it("opens on Shift+physical-slash even when e.key is missing the '?'", () => {
    // Defensive: some embedded webviews don't propagate the shifted
    // char into e.key. e.code is the reliable physical-key source.
    expect(shouldOpenCheatSheet({
      key: "/", code: "Slash", shiftKey: true,
    })).toBe(true);
  });

  it("opens on a genuine '?' character from any layout", () => {
    // German QWERTZ: Shift+ß produces "?" with e.code="Minus".
    expect(shouldOpenCheatSheet({
      key: "?", code: "Minus", shiftKey: true,
    })).toBe(true);
  });

  it("does NOT open on Shift+Digit7 (German QWERTZ — e.key='/')", () => {
    // The reported bug: user pressing Shift+7 to bind digit 7 had the
    // cheat-sheet pop up because e.key resolves to '/' on this layout.
    expect(shouldOpenCheatSheet({
      key: "/", code: "Digit7", shiftKey: true,
    })).toBe(false);
  });

  it("does NOT open on Shift+Digit1..Digit9 regardless of e.key", () => {
    for (let d = 1; d <= 9; d += 1) {
      expect(shouldOpenCheatSheet({
        key: "!", code: `Digit${d}`, shiftKey: true,
      })).toBe(false);
    }
  });

  it("does NOT open on Shift+Numpad1..Numpad9", () => {
    for (let d = 1; d <= 9; d += 1) {
      expect(shouldOpenCheatSheet({
        key: `${d}`, code: `Numpad${d}`, shiftKey: true,
      })).toBe(false);
    }
  });

  it("does NOT open on a plain digit (no shift)", () => {
    expect(shouldOpenCheatSheet({
      key: "5", code: "Digit5", shiftKey: false,
    })).toBe(false);
  });

  it("does NOT open on unrelated keys", () => {
    expect(shouldOpenCheatSheet({
      key: "a", code: "KeyA", shiftKey: false,
    })).toBe(false);
    expect(shouldOpenCheatSheet({
      key: "Enter", code: "Enter", shiftKey: false,
    })).toBe(false);
  });
});

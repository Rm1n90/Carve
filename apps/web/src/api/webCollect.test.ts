// Armin Mehri — mehri.armin@gmail.com
import { describe, expect, it } from "vitest";

import { parseKeywordList, splitTotal } from "./webCollect";

describe("parseKeywordList", () => {
  it("reads one keyword per line, with an optional count", () => {
    expect(
      parseKeywordList(
        "Tenneco logo, 300\n  Cadillac F1   car | 500 \n\n# a note\nPirelli tyre\nF1 2026\t40",
        100,
      ),
    ).toEqual([
      { keyword: "Tenneco logo", target: 300 },
      { keyword: "Cadillac F1 car", target: 500 },
      { keyword: "Pirelli tyre", target: 100 },
      { keyword: "F1 2026", target: 40 },
    ]);
  });

  it("keeps a number that is part of the words", () => {
    expect(parseKeywordList("Formula 1", 50)).toEqual([{ keyword: "Formula 1", target: 50 }]);
  });
});

describe("splitTotal", () => {
  it("splits as evenly as whole numbers allow", () => {
    expect(splitTotal(10, 3)).toEqual([4, 3, 3]);
    expect(splitTotal(22000, 20).every((n) => n === 1100)).toBe(true);
    expect(splitTotal(5, 0)).toEqual([]);
  });
});

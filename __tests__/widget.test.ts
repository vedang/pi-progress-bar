import { describe, expect, it } from "vitest";
import { clarityLabel } from "../src/ui/widget";

describe("deterministic display labels", () => {
  it.each([
    [-1, "unknown"],
    [Number.NaN, "unknown"],
    [0, "unclear"],
    [0.999, "unclear"],
    [1, "partly clear"],
    [1.999, "partly clear"],
    [2, "mostly clear"],
    [2.7, "mostly clear"],
    [2.999, "mostly clear"],
    [3, "clear"],
    [3.01, "unknown"],
  ])("maps %s without rounding to %s", (score, label) => {
    expect(clarityLabel(score)).toBe(label);
  });
});

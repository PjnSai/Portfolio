import { describe, expect, it } from "vitest";
import { currentSection, nextStep } from "@/lib/public/sections";

describe("nextStep", () => {
  it("goes to the first section from above it", () => {
    expect(nextStep(5, -1)).toEqual({ kind: "section", index: 0 });
  });

  it("goes to the section after the current one", () => {
    expect(nextStep(5, 0)).toEqual({ kind: "section", index: 1 });
    expect(nextStep(5, 3)).toEqual({ kind: "section", index: 4 });
  });

  it("goes back to the top from the last section", () => {
    expect(nextStep(5, 4)).toEqual({ kind: "top" });
    expect(nextStep(1, 0)).toEqual({ kind: "top" });
  });

  it("has nowhere to go with no sections", () => {
    expect(nextStep(0, -1)).toBeNull();
    expect(nextStep(0, 3)).toBeNull();
  });

  it("treats an out-of-range index safely", () => {
    expect(nextStep(5, -7)).toEqual({ kind: "section", index: 0 });
    expect(nextStep(5, 9)).toEqual({ kind: "top" });
  });
});

describe("currentSection", () => {
  it("is the section marked in view", () => {
    expect(currentSection(5, 2, false, null)).toBe(2);
    expect(currentSection(5, -1, false, null)).toBe(-1);
  });

  it("is the last section at the bottom of the page", () => {
    expect(currentSection(5, 3, true, null)).toBe(4);
  });

  it("is the section just jumped to while the scroll is still moving", () => {
    expect(currentSection(5, 0, false, 3)).toBe(3);
    expect(currentSection(5, 4, true, -1)).toBe(-1);
  });

  it("is above the first with no sections", () => {
    expect(currentSection(0, 2, true, 1)).toBe(-1);
  });

  it("steps through every section and then back to the top", () => {
    const visited: string[] = [];
    let current = -1;
    for (let i = 0; i < 7; i += 1) {
      const step = nextStep(5, current);
      if (!step) break;
      visited.push(step.kind === "top" ? "top" : String(step.index));
      current = step.kind === "top" ? -1 : step.index;
    }
    expect(visited).toEqual(["0", "1", "2", "3", "4", "top", "0"]);
  });
});

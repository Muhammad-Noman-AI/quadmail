import { describe, expect, it } from "vitest";
import { compareVersions } from "./version";

describe("compareVersions", () => {
  it("orders versions numerically, not as text", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.2.0", "2.0.0")).toBe(-1);
  });
});

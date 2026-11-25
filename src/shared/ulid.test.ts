import { describe, expect, it } from "vitest";
import { ulid, ulidTime } from "./ulid";

describe("ulid", () => {
  it("is 26 Crockford base32 characters", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("encodes its timestamp", () => {
    expect(ulidTime(ulid(1_795_000_000_000))).toBe(1_795_000_000_000);
  });
  it("sorts by time", () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });
});

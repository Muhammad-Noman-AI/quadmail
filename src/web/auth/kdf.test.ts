import { describe, expect, it } from "vitest";
import { derivePasswordKey } from "./kdf";

describe("derivePasswordKey", () => {
  it("derives a stable, email-salted 32-byte key", async () => {
    const a = await derivePasswordKey("Noman@QuadGentics.com ", "correct horse");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await derivePasswordKey("noman@quadgentics.com", "correct horse")).toBe(a);
    expect(await derivePasswordKey("other@quadgentics.com", "correct horse")).not.toBe(a);
  }, 20_000);
});

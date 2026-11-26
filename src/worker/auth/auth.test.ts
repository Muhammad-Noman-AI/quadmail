import { describe, expect, it } from "vitest";
import { decryptString, encryptString, fromHex, timingSafeEqual, toBase64 } from "./crypto";
import { hashPasswordKey, verifyPasswordKey } from "./password";
import { base32Decode, base32Encode, hotp, matchTotpStep, otpauthUri, verifyTotp } from "./totp";

describe("TOTP (RFC 6238 appendix B, SHA-1, 8 digits)", () => {
  // Secret is ASCII "12345678901234567890".
  const secret = new Uint8Array(new TextEncoder().encode("12345678901234567890"));
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [time, code] of vectors) {
    it(`T=${time}`, async () => {
      expect(await hotp(secret, Math.floor(time / 30), 8)).toBe(code);
    });
  }

  it("verifies 6-digit codes with ±1 step of drift and rejects others", async () => {
    const b32 = base32Encode(secret);
    const now = 1111111111 * 1000;
    const current = await hotp(base32Decode(b32), Math.floor(1111111111 / 30));
    expect(await verifyTotp(b32, current, now)).toBe(true);
    expect(await verifyTotp(b32, current, now + 30_000)).toBe(true);
    expect(await verifyTotp(b32, current, now + 90_000)).toBe(false);
    expect(await verifyTotp(b32, "abc123", now)).toBe(false);
  });

  it("round-trips base32 and builds an otpauth URI", () => {
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    expect(otpauthUri("JBSWY3DPEHPK3PXP", "noman@quadgentics.com")).toMatch(/^otpauth:\/\/totp\/QuadMail%3Anoman%40quadgentics\.com\?secret=JBSWY3DPEHPK3PXP&issuer=QuadMail/);
  });
});

describe("password", () => {
  it("verifies the right key and rejects a wrong one", async () => {
    const key = "a".repeat(64);
    const stored = await hashPasswordKey(key);
    expect(stored).toMatch(/^v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await verifyPasswordKey(key, stored)).toBe(true);
    expect(await verifyPasswordKey("b".repeat(64), stored)).toBe(false);
    expect(await verifyPasswordKey("not-hex", stored)).toBe(false);
  });

});

describe("crypto helpers", () => {
  it("encrypts and decrypts with AES-GCM", async () => {
    const key = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await encryptString("JBSWY3DPEHPK3PXP", key);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await decryptString(sealed, key)).toBe("JBSWY3DPEHPK3PXP");
    const other = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(decryptString(sealed, other)).rejects.toThrow();
  });

  it("compares in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(() => fromHex("zz")).toThrow();
  });
});

describe("matchTotpStep", () => {
  it("returns the step a code belongs to, so a used step can be refused", async () => {
    const b32 = base32Encode(new Uint8Array(20).fill(7));
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = await hotp(base32Decode(b32), step);
    expect(await matchTotpStep(b32, code, now)).toBe(step);
    expect(await matchTotpStep(b32, code, now + 30_000)).toBe(step);
    expect(await matchTotpStep(b32, "000000", now)).toBe(code === "000000" ? step : null);
  });
});

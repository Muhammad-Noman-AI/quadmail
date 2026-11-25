// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) on WebCrypto. Secrets are RFC 4648 base32.
import { randomBytes } from "./crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value for a counter, using `digits` digits (RFC 4226 dynamic truncation). */
export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = TOTP_DIGITS, hash = "SHA-1"): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/** True if `code` matches the current step or one step either side (clock drift). */
export async function verifyTotp(secretBase32: string, code: string, nowMs = Date.now()): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  let match = false;
  for (const delta of [-1, 0, 1]) {
    // Evaluate all three so timing does not reveal which window matched.
    if ((await hotp(secret, step + delta)) === code) match = true;
  }
  return match;
}

export function otpauthUri(secretBase32: string, account: string, issuer = "QuadMail"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

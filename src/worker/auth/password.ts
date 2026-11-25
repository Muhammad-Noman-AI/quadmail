// Server side of password verification. The client already ran 600,000 PBKDF2 iterations
// (src/web/auth/kdf.ts) and sends a 32-byte hex key. Because that input is high-entropy, a salted
// HMAC-SHA256 is enough here and costs microseconds, which keeps login under the 10 ms CPU limit.
// Stored format: v1$<salt hex>$<hmac hex>
//
// No imports on purpose: scripts/set-owner-password.ts runs this file directly under Node's
// TypeScript type stripping, which cannot resolve extensionless imports.

const PASSWORD_KEY_PATTERN = /^[0-9a-f]{64}$/;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isPasswordKey(value: unknown): value is string {
  return typeof value === "string" && PASSWORD_KEY_PATTERN.test(value);
}

async function mac(saltHex: string, passwordKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", unhex(saltHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, unhex(passwordKey)));
}

export async function hashPasswordKey(passwordKey: string): Promise<string> {
  if (!isPasswordKey(passwordKey)) throw new Error("password key must be 64 hex characters");
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `v1$${salt}$${await mac(salt, passwordKey)}`;
}

export async function verifyPasswordKey(passwordKey: string, stored: string): Promise<boolean> {
  const [version, salt, expected] = stored.split("$");
  if (version !== "v1" || !salt || !/^[0-9a-f]{32}$/.test(salt) || !expected || !isPasswordKey(passwordKey)) return false;
  return sameString(await mac(salt, passwordKey), expected);
}

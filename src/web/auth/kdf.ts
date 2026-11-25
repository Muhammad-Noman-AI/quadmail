// Client-side password stretching. Shared by the browser (login) and scripts/set-owner-password.ts.
// Must stay dependency-free and erasable-TypeScript-only so Node can run it with type stripping.
//
// Why in the browser: PBKDF2-SHA256 at 100,000 iterations costs ~40 ms of CPU, but a Worker on the
// free plan gets 10 ms per request. So the slow, brute-force-resistant step runs here (600,000
// iterations, the OWASP 2023 figure for PBKDF2-SHA256) and the server stores only a salted HMAC of
// the result (src/worker/auth/password.ts). A leaked database still costs an attacker 600,000
// iterations per guess; the derived key itself is never stored.

export const KDF_ITERATIONS = 600_000;

const encoder = new TextEncoder();

/** Hex-encoded 32-byte key derived from the password, salted with the normalised account email. */
export async function derivePasswordKey(email: string, password: string): Promise<string> {
  const salt = encoder.encode(`quadmail:v1:${email.trim().toLowerCase()}`);
  const base = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: KDF_ITERATIONS }, base, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

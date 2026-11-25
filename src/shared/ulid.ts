// ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. Sorts by creation time.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % 32];
  return time + random;
}

/** Epoch ms encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const char of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(char);
  return t;
}

// Text caps shared by the browser (index building) and the Worker (storing browser-supplied fields).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Truncate to at most `maxBytes` of UTF-8 without splitting a character. */
export function capUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes (10xxxxxx) so we cut on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

export function capChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

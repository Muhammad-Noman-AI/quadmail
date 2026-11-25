import { describe, expect, it } from "vitest";
import { contentDisposition } from "../routes/inbound";
import { attachmentKey, idFromRawKey, rawKey } from "../storage/inbound";
import { monthPrefixes } from "./reconcile";
import { capUtf8 } from "./text";

describe("R2 keys", () => {
  it("builds and reads raw keys", () => {
    const id = "01KAZXQ4V8W3G2F6H7J8K9M0NP";
    const key = rawKey(id, Date.UTC(2026, 0, 5));
    expect(key).toBe(`raw/2026/01/${id}.eml`);
    expect(idFromRawKey(key)).toBe(id);
    expect(idFromRawKey("raw/2026/01/smoke/x.eml")).toBeNull();
    expect(attachmentKey("m", "a")).toBe("att/m/a");
  });
});

describe("monthPrefixes", () => {
  it("returns previous and current month, across a year boundary", () => {
    expect(monthPrefixes(Date.UTC(2027, 0, 15))).toEqual(["raw/2026/12/", "raw/2027/01/"]);
  });
});

describe("contentDisposition", () => {
  it("keeps downloads safe for odd filenames", () => {
    expect(contentDisposition('a"b\r\n.pdf')).toBe(`attachment; filename="a_b__.pdf"; filename*=UTF-8''a_b__.pdf`);
    expect(contentDisposition("résumé.pdf")).toBe(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
    expect(contentDisposition(null)).toContain('filename="attachment"');
  });
});

describe("worker capUtf8", () => {
  it("matches the browser helper on character boundaries", () => {
    expect(capUtf8("😀😀", 5)).toBe("😀");
  });
});

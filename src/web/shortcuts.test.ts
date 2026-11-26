import { describe, expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const press = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  shortcutFor({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra } as Parameters<typeof shortcutFor>[0]);

describe("shortcutFor", () => {
  it("maps Gmail-style keys", () => {
    expect(press("c")).toBe("compose");
    expect(press("j")).toBe("next");
    expect(press("#")).toBe("delete");
    expect(press("Escape")).toBe("back");
    expect(press("x")).toBeNull();
  });

  it("ignores keys with modifiers, so browser shortcuts like Ctrl+C still work", () => {
    expect(press("c", { ctrlKey: true })).toBeNull();
    expect(press("r", { metaKey: true })).toBeNull();
  });

  it("ignores keys typed into fields and the editor", () => {
    expect(press("c", { target: { tagName: "INPUT" } })).toBeNull();
    expect(press("j", { target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(press("j", { target: { tagName: "DIV", isContentEditable: false } })).toBe("next");
  });
});

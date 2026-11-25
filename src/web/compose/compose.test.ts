// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Identity, MessageDetail, ParsedMessage } from "../../shared/types";
import { formatAddressInput, parseAddressInput } from "./addresses";
import { composeText, sanitizeComposeHtml } from "./html";
import { prefixSubject, replyInit } from "./prepare";

describe("parseAddressInput", () => {
  it("parses plain, named and quoted addresses separated by commas or semicolons", () => {
    expect(parseAddressInput('a@x.com; Ali Khan <ALI@y.com>, "Khan, Ali" <k@z.org>')).toEqual({
      addresses: [{ address: "a@x.com" }, { address: "ali@y.com", name: "Ali Khan" }, { address: "k@z.org", name: "Khan, Ali" }],
      invalid: [],
    });
  });

  it("reports invalid entries", () => {
    expect(parseAddressInput("good@x.com, nope, bad@").invalid).toEqual(["nope", "bad@"]);
  });

  it("round-trips through formatAddressInput", () => {
    const list = [{ address: "k@z.org", name: "Khan, Ali" }, { address: "a@x.com" }];
    expect(parseAddressInput(formatAddressInput(list)).addresses).toEqual(list);
  });
});

describe("compose html", () => {
  it("keeps formatting and safe links, drops scripts, images, styles and javascript: links", () => {
    const html = sanitizeComposeHtml('<p style="color:red"><b>Hi</b> <a href="https://x.com" onclick="x()">x</a><a href="javascript:alert(1)">y</a><img src="https://t.co/p.gif"><script>alert(1)</script></p>');
    expect(html).toBe('<p><b>Hi</b> <a href="https://x.com">x</a><a>y</a></p>');
  });

  it("builds a tidy plain-text alternative", () => {
    expect(composeText("<p>Hello &amp; welcome</p><p></p><p></p><div>Line<br>two</div>")).toBe("Hello & welcome\n\nLine\ntwo");
  });
});

describe("replies and forwards", () => {
  const identities: Identity[] = [
    { id: "1", address: "noman@quadgentics.com", displayName: "Noman", signatureHtml: "Noman<br>Quadgentics", isDefault: true },
    { id: "2", address: "sales@quadgentics.com", displayName: null, signatureHtml: null, isDefault: false },
  ];
  const message = {
    id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    direction: "in",
    from: { address: "friend@gmail.com", name: "Friend" },
    to: [{ address: "sales@quadgentics.com" }, { address: "other@x.com" }],
    cc: [{ address: "noman@quadgentics.com" }, { address: "boss@x.com" }],
    subject: "Quote <request>",
    receivedAt: Date.UTC(2026, 10, 20),
    attachments: [
      { id: "a1", filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, contentId: null, isInline: false },
      { id: "a2", filename: "logo.png", contentType: "image/png", sizeBytes: 10, contentId: "logo", isInline: true },
    ],
  } as unknown as MessageDetail;
  const content = { text: "Price?\n<b>now</b>" } as ParsedMessage;

  it("prefixes subjects once", () => {
    expect(prefixSubject("Re", "Re: hi")).toBe("Re: hi");
    expect(prefixSubject("Fwd", "hello")).toBe("Fwd: hello");
  });

  it("replies to the sender from the identity the mail was sent to, quoting escaped text", () => {
    const init = replyInit(message, content, "reply", identities);
    expect(init.from).toBe("sales@quadgentics.com");
    expect(init.to).toEqual([{ address: "friend@gmail.com", name: "Friend" }]);
    expect(init.cc).toEqual([]);
    expect(init.subject).toBe("Re: Quote <request>");
    expect(init.replyToId).toBe(message.id);
    expect(init.html).toContain("<blockquote>Price?<br>&lt;b&gt;now&lt;/b&gt;</blockquote>");
  });

  it("reply-all keeps everyone except my own addresses", () => {
    const init = replyInit(message, content, "replyAll", identities);
    expect(init.to.map((a) => a.address)).toEqual(["friend@gmail.com", "other@x.com"]);
    expect(init.cc.map((a) => a.address)).toEqual(["boss@x.com"]);
  });

  it("forward carries non-inline attachments and no recipients", () => {
    const init = replyInit(message, content, "forward", identities);
    expect(init.to).toEqual([]);
    expect(init.subject).toBe("Fwd: Quote <request>");
    expect(init.forwardAttachments?.map((a) => a.id)).toEqual(["a1"]);
    expect(init.replyToId).toBeUndefined();
  });
});

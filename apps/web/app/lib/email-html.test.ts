// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildIframeDoc, rewriteEmailHtml, sanitizeEmailHtml, stripAngles } from "./email-html";

const inlineUrl = (id: string) =>
  `https://test.local/api/attachments/${encodeURIComponent(id)}/inline`;

describe("stripAngles", () => {
  it("removes leading < and trailing >", () => {
    expect(stripAngles("<abc>")).toBe("abc");
    expect(stripAngles("<abc")).toBe("abc");
    expect(stripAngles("abc>")).toBe("abc");
    expect(stripAngles("abc")).toBe("abc");
  });
});

describe("rewriteEmailHtml", () => {
  it("rewrites cid: srcs to the inline attachment URL when the cid resolves", () => {
    const html = `<p>hi</p><img src="cid:image001@example" alt="logo">`;
    const cidMap = new Map([["image001@example", "att_42"]]);
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: cidMap,
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.html).toContain(`src="https://test.local/api/attachments/att_42/inline"`);
    expect(result.blockedRemote).toBe(false);
  });

  it("strips cid: references that don't resolve and leaves an alt placeholder", () => {
    const html = `<img src="cid:missing@example">`;
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.html).not.toContain("src=");
    expect(result.html).toContain("(missing inline image)");
  });

  it("blocks remote images when allowRemoteImages is false", () => {
    const html = `<img src="https://tracker.example/pixel.gif">`;
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.blockedRemote).toBe(true);
    // The original src is stashed on a data-attribute so the user
    // can opt-in via the "Display images" prompt without re-fetching
    // the message; we just have to make sure it isn't loaded as src.
    expect(result.html).not.toMatch(/<img[^>]*(?:^|\s)src=/);
    expect(result.html).toContain(`data-mailai-remote-src="https://tracker.example/pixel.gif"`);
  });

  it("keeps remote images when allowRemoteImages is true", () => {
    const html = `<img src="https://cdn.example/banner.png">`;
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: true,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.blockedRemote).toBe(false);
    expect(result.html).toContain(`src="https://cdn.example/banner.png"`);
  });

  it("preserves data: and same-origin / root-relative srcs", () => {
    const html = [
      `<img src="data:image/png;base64,AAAA">`,
      `<img src="/api/attachments/x/inline">`,
    ].join("");
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.html).toContain(`src="data:image/png;base64,AAAA"`);
    expect(result.html).toContain(`src="/api/attachments/x/inline"`);
    expect(result.blockedRemote).toBe(false);
  });

  it("strips background-image url(http(s)) declarations when remote images are blocked", () => {
    const html = `<div style="background-image: url('https://tracker.example/pixel.gif'); color: red;">x</div>`;
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.blockedRemote).toBe(true);
    expect(result.html).not.toContain("tracker.example");
    expect(result.html).toContain("color: red");
  });

  it("strips weird schemes (file://, ftp://) it doesn't recognise", () => {
    const html = `<img src="file:///etc/passwd"><img src="javascript:alert(1)">`;
    const result = rewriteEmailHtml({
      html,
      cidToAttachmentId: new Map(),
      allowRemoteImages: false,
      attachmentInlineUrl: inlineUrl,
    });
    expect(result.html).not.toContain("file://");
    expect(result.html).not.toContain("javascript:");
  });
});

describe("sanitizeEmailHtml", () => {
  it("strips <script> tags entirely", () => {
    const out = sanitizeEmailHtml(`<p>hi</p><script>alert(1)</script>`);
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeEmailHtml(`<a href="#" onclick="evil()">x</a>`);
    expect(out).not.toContain("onclick");
  });

  it("KEEPS <style> tags so email layouts survive (the iframe has no allow-scripts)", () => {
    const out = sanitizeEmailHtml(
      `<style>.banner { background: white; padding: 20px; }</style><div class="banner">hi</div>`,
    );
    expect(out).toContain("<style");
    expect(out).toContain(".banner");
    expect(out).toContain('class="banner"');
  });

  it("keeps inline style attributes (used by every marketing email)", () => {
    const out = sanitizeEmailHtml(
      `<table style="width: 100%; background-color: #f5f5f5;"><tr><td>cell</td></tr></table>`,
    );
    expect(out).toContain('style="width: 100%; background-color: #f5f5f5;"');
  });

  it("strips <link> and <meta> so a sender can't pull external CSS", () => {
    const out = sanitizeEmailHtml(
      `<link rel="stylesheet" href="https://evil/x.css"><meta http-equiv="refresh" content="0;url=https://evil"><p>ok</p>`,
    );
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<meta");
    expect(out).toContain("<p>ok</p>");
  });

  it("strips <iframe>, <object>, and <embed>", () => {
    const out = sanitizeEmailHtml(
      `<iframe src="https://evil"></iframe><object data="x"></object><embed src="x">`,
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  it("strips javascript: URLs in href", () => {
    const out = sanitizeEmailHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(out).not.toContain("javascript:");
  });
});

describe("buildIframeDoc", () => {
  it("defaults to a light HTML shell with a white canvas", () => {
    const doc = buildIframeDoc(`<p>hello</p>`);
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<p>hello</p>");
    expect(doc).toContain("color-scheme: only light");
    expect(doc).toContain("background: #ffffff");
    // Always opens links in a new tab.
    expect(doc).toContain(`<base target="_blank"`);
  });

  it("paints the canvas dark when darkMode is true so personal mail blends with the app", () => {
    const doc = buildIframeDoc(`<p>hi</p>`, { darkMode: true });
    expect(doc).toContain("background: #191919");
    expect(doc).toContain("color-scheme: dark");
    // The canvas blends; we deliberately do NOT invert sender colours
    // — that's what historically caused table-cell banner artifacts.
    expect(doc).not.toContain("invert(1)");
    expect(doc).not.toContain("hue-rotate");
  });

  it("never reaches for the invert/hue-rotate dark trick in light mode either", () => {
    const doc = buildIframeDoc(`<p>hi</p>`);
    expect(doc).not.toContain("invert(1)");
    expect(doc).not.toContain("hue-rotate");
  });

  it("includes max-width on images so wide banners don't blow out the layout", () => {
    const doc = buildIframeDoc("");
    expect(doc).toMatch(/img\s*\{[^}]*max-width:\s*100%/);
  });
});

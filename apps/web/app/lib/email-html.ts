// Provider-agnostic email HTML pipeline: sanitize, rewrite, wrap.
//
// Three small functions, in this order:
//
//   1. rewriteEmailHtml — rewrites `cid:` image references to our
//      attachment proxy, resolves bare filenames (`src="logo.png"`)
//      when they match a message attachment's filename (many MIME
//      clients reference related parts this way), and (optionally)
//      blocks remote images for privacy. Runs against the original HTML
//      so the cid->attachment lookup still has access to whatever
//      attributes the sender used.
//
//   2. sanitizeEmailHtml — runs the rewritten HTML through DOMPurify
//      with an email-friendly allow-list. Critically we KEEP `<style>`
//      tags: most marketing/transactional templates rely on a head
//      stylesheet for layout and stripping it leaves the message as a
//      pile of unstyled text or, worse, a blank-looking white block
//      because the sender's "everything is hidden until CSS arrives"
//      tricks never recover.
//
//   3. buildIframeDoc — wraps the sanitized fragment in a minimal <html>
//      document with baseline typography. The iframe html/body use a
//      transparent canvas so thread chrome matches the shell.
//      Colours mirror the active design-system tokens passed as
//      `theme` from `readEmailIframeThemeSnapshot()` (fallback: package
//      colors when no DOM / tests).
//      When `darkMode: true`, the fragment sits in `.mailai-dark-reader`
//      with invert + hue-rotate (images are re-inverted).
//
// Why these are exported from a standalone module: they're pure
// string transforms and the test suite exercises them in node-only
// vitest without spinning up React/jsdom.
//
// Security note: the iframe is rendered with `sandbox="allow-popups
// allow-popups-to-escape-sandbox allow-same-origin"`. We deliberately
// keep `allow-scripts` off — that's what makes keeping `<style>` and
// inline `style` attributes safe even though DOMPurify also strips
// `expression()` / `javascript:` URLs from CSS.

import DOMPurify from "dompurify";
import { colors } from "@mailai/design-tokens/colors";

/** Allowlist CSS fragments we inject into the iframe stylesheet (never sender HTML). */
const CSS_INTRINSIC_UNSAFE =
  /[;{}<>\n\r\f\v]|\/\*|\*\/|@\s*import|\\0|url\s*\(|javascript:/i;

export function sanitizeCssInjectable(value: string, fallback: string): string {
  const v = value.trim();
  if (v.length === 0 || v.length > 140 || CSS_INTRINSIC_UNSAFE.test(v)) {
    return fallback;
  }
  return v;
}

export interface EmailIframeThemeSnapshot {
  readonly foreground: string;
  readonly accent: string;
  readonly secondary: string;
  readonly divider: string;
  /** Light canvas colour for invert reader (typically white). */
  readonly readerPaper: string;
  /** Body text colour on that canvas before invert (preset light foreground). */
  readonly readerInk: string;
  /**
   * Host `background` (`--background`) for dark-mode iframe letterboxing so
   * the embed matches reading-pane chrome (#191919, preset variants, rgb()).
   */
  readonly chromeBackground: string;
}

export function fallbackEmailIframeThemeSnapshot(): EmailIframeThemeSnapshot {
  return {
    foreground: colors.foreground,
    accent: colors.accent,
    secondary: colors.secondary,
    divider: colors.divider,
    readerPaper: colors.background,
    readerInk: colors.foreground,
    chromeBackground: colors.backgroundDark,
  };
}

export function stripAngles(s: string): string {
  return s.replace(/^<|>$/g, "");
}

export interface RewriteResult {
  readonly html: string;
  readonly blockedRemote: boolean;
}

// Rewrite `cid:` references to /api/attachments/:id/inline so the
// iframe can load them directly from the API. Block all remote
// (http/https) images by default; the parent can opt in.
//
// `attachmentInlineUrl` is injected so the function stays testable
// without a global baseUrl().
export function rewriteEmailHtml(args: {
  html: string;
  cidToAttachmentId: ReadonlyMap<string, string>;
  /**
   * Lowercased attachment basenames (e.g. `image.png`) → oauth attachment
   * id. Only used for same-message parts; arbitrary relative URLs are
   * still not fetched — we only substitute when the basename matches a
   * known attachment row.
   */
  filenameToAttachmentId?: ReadonlyMap<string, string>;
  allowRemoteImages: boolean;
  attachmentInlineUrl: (attachmentId: string) => string;
}): RewriteResult {
  if (typeof DOMParser === "undefined") {
    return { html: args.html, blockedRemote: false };
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(args.html, "text/html");
  let blockedRemote = false;

  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("cid:")) {
      const cid = stripAngles(src.slice(4));
      const attId =
        args.cidToAttachmentId.get(cid) ?? args.cidToAttachmentId.get(cid.toLowerCase());
      if (attId) {
        img.setAttribute("src", args.attachmentInlineUrl(attId));
      } else {
        img.removeAttribute("src");
        img.setAttribute("alt", img.getAttribute("alt") ?? "(missing inline image)");
      }
      return;
    }
    if (/^https?:/i.test(src)) {
      if (!args.allowRemoteImages) {
        blockedRemote = true;
        img.setAttribute("data-mailai-remote-src", src);
        img.removeAttribute("src");
      }
      return;
    }
    if (src.startsWith("data:")) return;
    if (src.startsWith("/")) return;
    if (src.length > 0) {
      const fnMap = args.filenameToAttachmentId;
      if (fnMap && fnMap.size > 0) {
        const isBarePartRef = !src.includes("://");
        if (isBarePartRef) {
          const segment = src.split(/[/\\]/).pop() ?? src;
          let key = segment.trim();
          try {
            key = decodeURIComponent(key);
          } catch {
            // keep trimmed segment
          }
          key = key.toLowerCase();
          const byName = key ? fnMap.get(key) : undefined;
          if (byName) {
            img.setAttribute("src", args.attachmentInlineUrl(byName));
            return;
          }
        }
      }
      // Anything else (file://, ftp://, weird relative paths) — drop
      // the src so we don't end up firing arbitrary network requests
      // from a sandboxed iframe.
      img.removeAttribute("src");
    }
  });

  // Background-image style attributes that reference cid: or remote
  // URLs. We don't try to parse arbitrary CSS shorthand — we just
  // strip the offending `background-image` declaration when it points
  // at a remote URL the user hasn't allowed.
  if (!args.allowRemoteImages) {
    doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const style = el.getAttribute("style") ?? "";
      if (/url\(\s*['"]?https?:/i.test(style)) {
        el.setAttribute(
          "style",
          style.replace(
            /background(?:-image)?\s*:\s*[^;]*url\(\s*['"]?https?:[^)]*\)[^;]*;?/gi,
            "",
          ),
        );
        blockedRemote = true;
      }
    });
  }

  return { html: doc.body.innerHTML, blockedRemote };
}

// Strip everything dangerous: scripts, event handlers, javascript:
// URLs, <object>/<embed>/<iframe>, etc. KEEP <style> + style
// attributes — emails depend on them for layout and the iframe runs
// without `allow-scripts` so CSS-only payloads can't escape.
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // The "html" profile drops <style> by default; we add it back
    // because emails depend on head stylesheets for layout. CSS
    // expressions / javascript: URLs inside the stylesheet are still
    // stripped by DOMPurify's CSS sanitizer.
    //
    // FORCE_BODY: true is required so a leading <style> in a body
    // fragment isn't treated as head-only and stripped — without it
    // DOMPurify drops the rule even when ADD_TAGS allows the tag.
    ADD_TAGS: ["style"],
    FORCE_BODY: true,
    // <link>/<meta>/<base> stay forbidden so a sender can't pull
    // external stylesheets, set <meta http-equiv="refresh">, or
    // override our <base target="_blank">.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: [
      "onerror",
      "onclick",
      "onload",
      "onmouseover",
      "onfocus",
      "onblur",
      "onchange",
      "onsubmit",
      "onkeydown",
      "onkeyup",
      "onkeypress",
    ],
    ALLOW_DATA_ATTR: false,
  });
}

// Dark mode for email content is hard. Strategies:
//
//   (a) "Always light" — safe for sender-pinned colours; jarring in a
//       dark chrome (bright white card).
//
//   (b) "Blend canvas only" — body color/background only; fails when
//       mail uses inline `color:` (most HTML).
//
//   (c) "Invert wrapper" — transparent iframe chrome outside the subtree;
//       wrap content in `.mailai-dark-reader` with invert + hue-rotate,
//       then re-invert `img`, `video`, and `svg` so photos/icons look normal.
//       Same trade-offs as Apple Mail / many readers: unusual brand colours
//       can look off, but typical black-on-white mail becomes light-on-dark.
//
// ThreadView uses (a) in light theme and (c) when the app resolves to
// dark. `darkMode: true` still selects (c) for tests/embeds.
//
// We previously rejected unscoped invert on the entire iframe document
// because it broke padding/flash; scoping to the content wrapper keeps
// the outer canvas stable.
export interface IframeDocOptions {
  readonly darkMode?: boolean;
  /**
   * Computed semantic colours from `readEmailIframeThemeSnapshot(document.documentElement)`.
   * When omitted (SSR / tests), defaults to `@mailai/design-tokens` literals.
   */
  readonly theme?: EmailIframeThemeSnapshot;
}

export function buildIframeDoc(sanitizedBody: string, opts: IframeDocOptions = {}): string {
  const dark = opts.darkMode === true;
  const fb = fallbackEmailIframeThemeSnapshot();
  const t = opts.theme ?? fb;
  const fg = sanitizeCssInjectable(t.foreground, fb.foreground);
  const ac = sanitizeCssInjectable(t.accent, fb.accent);
  const sec = sanitizeCssInjectable(t.secondary, fb.secondary);
  const div = sanitizeCssInjectable(t.divider, fb.divider);
  const paper = sanitizeCssInjectable(t.readerPaper, fb.readerPaper);
  const ink = sanitizeCssInjectable(t.readerInk, fb.readerInk);
  const chromeBg = sanitizeCssInjectable(t.chromeBackground, fb.chromeBackground);

  const bodyInner = dark
    ? `<div class="mailai-dark-reader">${sanitizedBody}</div>`
    : sanitizedBody;

  const styles = dark
    ? `
  /*
   * Do not advertise :root dark — WebKit/Chromium paint a contrasting
   * frame around iframe viewports when the embed root is dark-themed.
   */
  :root { color-scheme: normal; }
  /*
   * Opaque canvas below/to the sides of content: transparent html lets many
   * UAs paint the iframe viewport buffer white. Use host --background via
   * chromeBackground — not inverted mail black (#000) — so seams match shell.
   */
  html {
    margin: 0;
    padding: 0;
    background: ${chromeBg};
    overflow-x: hidden;
  }
  body {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }
  /*
   * Padding lives on .mailai-dark-reader so no inset gutter sits
   * outside the inverted subtree (avoids visible seams against the iframe).
   */
  .mailai-dark-reader {
    box-sizing: border-box;
    padding: 12px 14px;
    color-scheme: only light;
    background: ${paper};
    color: ${ink};
    filter: invert(1) hue-rotate(180deg);
  }
  .mailai-dark-reader img,
  .mailai-dark-reader picture > img,
  .mailai-dark-reader video,
  .mailai-dark-reader svg {
    filter: invert(1) hue-rotate(180deg);
  }
  .mailai-dark-reader img {
    cursor: zoom-in;
    max-width: 100%;
    height: auto;
  }
  .mailai-dark-reader blockquote {
    border-left: 2px solid ${div};
    margin: 0 0 8px 0;
    padding: 0 0 0 12px;
    color: ${sec};
  }
  .mailai-dark-reader pre,
  .mailai-dark-reader code {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .mailai-dark-reader table {
    max-width: 100%;
  }
`
    : `
  :root { color-scheme: only light; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${fg};
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    padding: 12px 14px;
  }
  a { color: ${ac}; }
  img {
    cursor: zoom-in;
    max-width: 100%;
    height: auto;
  }
  blockquote {
    border-left: 2px solid ${div};
    margin: 0 0 8px 0;
    padding: 0 0 0 12px;
    color: ${sec};
  }
  pre, code {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  table { max-width: 100%; }
`;

  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base target="_blank" />
<style>${styles}</style>
</head><body>${bodyInner}</body></html>`;
}

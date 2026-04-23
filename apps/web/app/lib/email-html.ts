// Provider-agnostic email HTML pipeline: sanitize, rewrite, wrap.
//
// Three small functions, in this order:
//
//   1. rewriteEmailHtml — rewrites `cid:` image references to our
//      attachment proxy and (optionally) blocks remote images for
//      privacy. Runs against the original HTML so the cid->attachment
//      lookup still has access to whatever attributes the sender used.
//
//   2. sanitizeEmailHtml — runs the rewritten HTML through DOMPurify
//      with an email-friendly allow-list. Critically we KEEP `<style>`
//      tags: most marketing/transactional templates rely on a head
//      stylesheet for layout and stripping it leaves the message as a
//      pile of unstyled text or, worse, a blank-looking white block
//      because the sender's "everything is hidden until CSS arrives"
//      tricks never recover.
//
//   3. buildIframeDoc — wraps the sanitized fragment in a minimal
//      <html> document with our own base styles and forces a light
//      color-scheme. We render every email on white regardless of the
//      app theme: it matches what Gmail / Outlook do in dark mode and
//      gives senders a predictable canvas (almost every email is
//      designed against white).
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
      const attId = args.cidToAttachmentId.get(cid);
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

// Dark mode for email content is hard. The two strategies the industry
// uses are:
//
//   (a) "Always light" — render every email on white regardless of
//       app theme (Gmail web, Outlook web, Front, Superhuman). Gives
//       a predictable canvas for marketing templates that assume
//       white but means the inbox momentarily flashes a bright card
//       in an otherwise dark UI.
//
//   (b) "Blend the canvas" — repaint just the html/body background
//       to match the surrounding app and override the *default* text
//       colour, but DON'T globally invert. Personal mail (Gmail-to-
//       Gmail, Outlook-to-Outlook, plain-text replies) inherits the
//       dark canvas and looks native. Marketing templates that hard-
//       code their own bgcolor on tables/divs keep their colours and
//       sit as light islands inside the dark frame — which is the
//       same behaviour Apple Mail Desktop ships.
//
// We previously tried the third strategy — `filter: invert(1)
// hue-rotate(180deg)` on body — and it always shipped collateral
// damage: hard-coded `bgcolor` cells became near-black banners,
// images grew white re-inverted seams, and the filter scope leaked
// through the iframe padding. Don't reach for it.
//
// We default to (a) so the test-only / SSR path stays predictable;
// the runtime caller (HtmlBody in ThreadView) opts into (b) when the
// app theme resolves dark.
export interface IframeDocOptions {
  readonly darkMode?: boolean;
}

export function buildIframeDoc(sanitizedBody: string, opts: IframeDocOptions = {}): string {
  const dark = opts.darkMode === true;
  // The dark canvas matches `--background` from the design tokens
  // (#191919). Foreground inherits the app's `--foreground` (#e3e2e0)
  // for text whose colour the email did NOT pin itself.
  const canvas = dark ? "#191919" : "#ffffff";
  const text = dark ? "#e3e2e0" : "#1f1f1f";
  const linkColor = dark ? "#7aa7ff" : "#2563eb";
  const blockquoteBorder = dark ? "#3a3a3a" : "#d6d6d4";
  const blockquoteText = dark ? "#a4a4a2" : "#6b6b69";
  const colorScheme = dark ? "dark" : "only light";

  const styles = `
  :root { color-scheme: ${colorScheme}; }
  html, body {
    margin: 0;
    padding: 0;
    background: ${canvas};
    color: ${text};
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
  a { color: ${linkColor}; }
  img {
    max-width: 100%;
    height: auto;
  }
  blockquote {
    border-left: 2px solid ${blockquoteBorder};
    margin: 0 0 8px 0;
    padding: 0 0 0 12px;
    color: ${blockquoteText};
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
</head><body>${sanitizedBody}</body></html>`;
}

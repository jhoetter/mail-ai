// Compose RFC 5322 messages with proper threading + UTF-8 everywhere.
// Uses libmime for header encoding; we deliberately do NOT pull in
// nodemailer here so that `packages/mime` remains a parser/composer with
// zero socket surface. SMTP submission lives in `packages/smtp-send`.

import libmime from "libmime";
import { randomUUID } from "node:crypto";
import type { IcsMethod } from "./ics.js";

export type AttachmentDisposition = "attachment" | "inline";

export interface AttachmentSpec {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  // `inline` parts are referenced from HTML via cid: URLs; the
  // composer wraps them in a `multipart/related` next to the
  // text/html part so RFC 2387-aware clients can resolve them.
  readonly disposition?: AttachmentDisposition;
  // Content-ID without angle brackets. Required for inline parts; the
  // composer wraps it in `<…>` to satisfy RFC 2392.
  readonly contentId?: string;
}

export interface ForwardedMessageSpec {
  // The raw RFC 822 bytes of the message being forwarded. Will be
  // attached as a `message/rfc822` part inside the outer
  // multipart/mixed envelope, which is what every modern client
  // unwraps as "Forwarded message".
  readonly raw: Buffer;
  // Optional friendly filename so receiving clients can offer
  // "download original.eml" if they don't unwrap inline.
  readonly filename?: string;
}

export interface DraftSpec {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments?: readonly AttachmentSpec[];
  readonly forwarded?: ForwardedMessageSpec;
  readonly hostname?: string;
  // Extra headers we want to surface to the wire. Used by the OAuth
  // send path to pass `Reply-To` or provider-specific headers.
  readonly extraHeaders?: readonly { name: string; value: string }[];
  // RFC 5545 / iTIP calendar payload. When set, the composer emits a
  // `text/calendar; method=<METHOD>` body part inside the multipart/mixed
  // envelope and additionally re-attaches the same bytes as
  // `application/ics; name=invite.ics` because Outlook desktop only
  // surfaces the meeting card from the second form for some flows.
  readonly calendar?: { readonly method: IcsMethod; readonly ics: string };
}

export interface ComposedMessage {
  readonly messageId: string;
  readonly raw: Buffer;
}

function encodeHeader(name: string, value: string): string {
  return `${name}: ${libmime.encodeWords(value, "Q")}\r\n`;
}

function base64Wrap(buf: Buffer): string {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function partInline(att: AttachmentSpec): string {
  const cid = att.contentId ?? "";
  const lines = [
    `Content-Type: ${att.contentType}; name="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: inline; filename="${att.filename}"`,
  ];
  if (cid) lines.push(`Content-ID: <${cid}>`);
  lines.push("", base64Wrap(att.content));
  return lines.join("\r\n");
}

function partAttachment(att: AttachmentSpec): string {
  return [
    `Content-Type: ${att.contentType}; name="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${att.filename}"`,
    "",
    base64Wrap(att.content),
  ].join("\r\n");
}

// `text/calendar` part embedded directly in the outer multipart/mixed.
// The METHOD parameter is critical: Gmail / Apple Mail / Outlook all
// branch on it to decide whether to render the "RSVP" buttons.
function partCalendar(method: IcsMethod, ics: string): string {
  return [
    `Content-Type: text/calendar; charset=UTF-8; method=${method}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrap(Buffer.from(ics, "utf8")),
  ].join("\r\n");
}

// Belt-and-suspenders second copy of the same .ics, surfaced as a
// regular file attachment so older Outlook desktop builds (which only
// look for application/ics-formatted parts) still get a meeting card.
function partCalendarAttachment(ics: string): string {
  const filename = "invite.ics";
  return [
    `Content-Type: application/ics; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    base64Wrap(Buffer.from(ics, "utf8")),
  ].join("\r\n");
}

function partForwarded(fwd: ForwardedMessageSpec): string {
  // RFC 2046 §5.2.1 — message/rfc822 carries the original message
  // verbatim; no Content-Transfer-Encoding rewrap.
  const filename = fwd.filename ?? "forwarded.eml";
  return [
    `Content-Type: message/rfc822; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    fwd.raw.toString("utf8"),
  ].join("\r\n");
}

function partAlternative(textBody: string | undefined, htmlBody: string | undefined): string {
  const hasBoth = !!textBody && !!htmlBody;
  if (!hasBoth) {
    const body = htmlBody ?? textBody ?? "";
    const ct = htmlBody ? "text/html" : "text/plain";
    return [`Content-Type: ${ct}; charset=UTF-8`, "Content-Transfer-Encoding: 8bit", "", body].join(
      "\r\n",
    );
  }
  const boundary = `=_alt_${randomUUID()}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    textBody ?? "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody ?? "",
    `--${boundary}--`,
  ].join("\r\n");
}

export function composeMessage(draft: DraftSpec): ComposedMessage {
  const messageId = `<${randomUUID()}@${draft.hostname ?? "mailai.local"}>`;
  const headers: string[] = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    encodeHeader("From", draft.from).trimEnd(),
    encodeHeader("To", draft.to.join(", ")).trimEnd(),
  ];
  if (draft.cc?.length) headers.push(encodeHeader("Cc", draft.cc.join(", ")).trimEnd());
  if (draft.bcc?.length) headers.push(encodeHeader("Bcc", draft.bcc.join(", ")).trimEnd());
  headers.push(encodeHeader("Subject", draft.subject).trimEnd());
  if (draft.inReplyTo) headers.push(`In-Reply-To: ${draft.inReplyTo}`);
  if (draft.references?.length) headers.push(`References: ${draft.references.join(" ")}`);
  for (const h of draft.extraHeaders ?? []) {
    headers.push(`${h.name}: ${h.value}`);
  }

  const inlineAtts = (draft.attachments ?? []).filter((a) => a.disposition === "inline");
  const regularAtts = (draft.attachments ?? []).filter((a) => a.disposition !== "inline");
  const hasInline = inlineAtts.length > 0;
  const hasRegular = regularAtts.length > 0;
  const hasForward = !!draft.forwarded;
  const hasCalendar = !!draft.calendar;
  const hasMixed = hasRegular || hasForward || hasCalendar;

  // Single-part fast path: just text or just html, no attachments.
  if (!hasInline && !hasMixed && !(draft.htmlBody && draft.textBody)) {
    const body = draft.htmlBody ?? draft.textBody ?? "";
    const ct = draft.htmlBody ? "text/html" : "text/plain";
    headers.push(`Content-Type: ${ct}; charset=UTF-8`);
    headers.push("Content-Transfer-Encoding: 8bit");
    return {
      messageId,
      raw: Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body + "\r\n", "utf8"),
    };
  }

  // Build the body (alternative + optional related-wrap for inline images).
  const altBlock = partAlternative(draft.textBody, draft.htmlBody);
  let bodyPart: string;
  if (hasInline) {
    const relatedBoundary = `=_rel_${randomUUID()}`;
    const inlineParts = inlineAtts.map(partInline);
    const segments = [
      `Content-Type: multipart/related; boundary="${relatedBoundary}"; type="multipart/alternative"`,
      "",
      `--${relatedBoundary}`,
      altBlock,
      ...inlineParts.flatMap((p) => [`--${relatedBoundary}`, p]),
      `--${relatedBoundary}--`,
    ];
    bodyPart = segments.join("\r\n");
  } else {
    bodyPart = altBlock;
  }

  if (!hasMixed) {
    return {
      messageId,
      raw: Buffer.from(headers.join("\r\n") + "\r\n" + bodyPart + "\r\n", "utf8"),
    };
  }

  // Outer multipart/mixed wraps the (possibly related-wrapped)
  // alternative, plus regular attachments and the forwarded EML.
  const mixedBoundary = `=_mix_${randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const parts: string[] = [`--${mixedBoundary}`, bodyPart];
  if (draft.calendar) {
    parts.push(`--${mixedBoundary}`);
    parts.push(partCalendar(draft.calendar.method, draft.calendar.ics));
  }
  for (const att of regularAtts) {
    parts.push(`--${mixedBoundary}`);
    parts.push(partAttachment(att));
  }
  if (draft.forwarded) {
    parts.push(`--${mixedBoundary}`);
    parts.push(partForwarded(draft.forwarded));
  }
  if (draft.calendar) {
    parts.push(`--${mixedBoundary}`);
    parts.push(partCalendarAttachment(draft.calendar.ics));
  }
  parts.push(`--${mixedBoundary}--`);

  return {
    messageId,
    raw: Buffer.from(headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + "\r\n", "utf8"),
  };
}

// Compose RFC 5322 messages with proper threading + UTF-8 everywhere.
// Uses libmime for header encoding; we deliberately do NOT pull in
// nodemailer here so that `packages/mime` remains a parser/composer with
// zero socket surface. SMTP submission lives in `packages/smtp-send`.

import libmime from "libmime";
import { randomUUID } from "node:crypto";

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
  readonly attachments?: readonly { filename: string; contentType: string; content: Buffer }[];
  readonly hostname?: string;
}

export interface ComposedMessage {
  readonly messageId: string;
  readonly raw: Buffer;
}

function encodeHeader(name: string, value: string): string {
  return `${name}: ${libmime.encodeWords(value, "Q")}\r\n`;
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

  const hasAtt = !!draft.attachments?.length;
  const hasAlt = !!(draft.htmlBody && draft.textBody);

  if (!hasAtt && !hasAlt) {
    const body = draft.htmlBody ?? draft.textBody ?? "";
    const ct = draft.htmlBody ? "text/html" : "text/plain";
    headers.push(`Content-Type: ${ct}; charset=UTF-8`);
    headers.push("Content-Transfer-Encoding: 8bit");
    return {
      messageId,
      raw: Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body + "\r\n", "utf8"),
    };
  }

  const altBoundary = `=_alt_${randomUUID()}`;
  const mixedBoundary = `=_mix_${randomUUID()}`;

  const altPart = (() => {
    if (!hasAlt) {
      const body = draft.htmlBody ?? draft.textBody ?? "";
      const ct = draft.htmlBody ? "text/html" : "text/plain";
      return [`Content-Type: ${ct}; charset=UTF-8`, "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
    }
    return [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      draft.textBody ?? "",
      `--${altBoundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      draft.htmlBody ?? "",
      `--${altBoundary}--`,
    ].join("\r\n");
  })();

  if (!hasAtt) {
    return {
      messageId,
      raw: Buffer.from(headers.join("\r\n") + "\r\n" + altPart + "\r\n", "utf8"),
    };
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const parts: string[] = [`--${mixedBoundary}`, altPart];
  for (const att of draft.attachments ?? []) {
    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    parts.push("");
    parts.push(att.content.toString("base64").replace(/(.{76})/g, "$1\r\n"));
  }
  parts.push(`--${mixedBoundary}--`);

  return {
    messageId,
    raw: Buffer.from(headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + "\r\n", "utf8"),
  };
}

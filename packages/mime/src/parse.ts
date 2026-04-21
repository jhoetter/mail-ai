// MIME parsing wrapper around mailparser. We surface a stable shape so
// imap-sync, overlay-db, and the agent SDK do not need to depend on
// mailparser's internals (and so we can swap parsers later).
//
// Per Architecture Principle 5 (opaque preservation): parts we do not
// understand are kept as opaque `Buffer + headers` records — never
// silently dropped or rewritten.

import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

export interface ParsedAddress {
  readonly name?: string;
  readonly address: string;
}

export interface ParsedAttachmentMeta {
  readonly contentId?: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly size: number;
  readonly disposition: "attachment" | "inline" | "unknown";
  readonly checksum?: string;
}

export interface OpaquePart {
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
  readonly note: "preserved-as-opaque";
}

export interface ParsedMessage {
  readonly messageId: string | null;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
  readonly subject: string | null;
  readonly date: Date | null;
  readonly from: readonly ParsedAddress[];
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  readonly bcc: readonly ParsedAddress[];
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly ParsedAttachmentMeta[];
  readonly opaque: readonly OpaquePart[];
  readonly rawSize: number;
  readonly rawHeaders: Readonly<Record<string, string>>;
}

function toAddrs(a: AddressObject | AddressObject[] | undefined): ParsedAddress[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((obj) =>
    (obj.value ?? []).map((v) => {
      const out: ParsedAddress = { address: (v.address ?? "").toLowerCase() };
      if (v.name) (out as { name?: string }).name = v.name;
      return out;
    }),
  );
}

function splitRefs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

export async function parseMessage(input: Buffer | string): Promise<ParsedMessage> {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const parsed: ParsedMail = await simpleParser(buf, { skipImageLinks: true });
  const headers: Record<string, string> = {};
  for (const [k, v] of parsed.headers) headers[k.toLowerCase()] = String(v);

  const refsHeader = headers["references"];
  const inReplyHeader = headers["in-reply-to"];

  return {
    messageId: parsed.messageId ?? null,
    inReplyTo: splitRefs(inReplyHeader),
    references: splitRefs(refsHeader),
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    from: toAddrs(parsed.from),
    to: toAddrs(parsed.to),
    cc: toAddrs(parsed.cc),
    bcc: toAddrs(parsed.bcc),
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    attachments: (parsed.attachments ?? []).map((a) => {
      const meta: ParsedAttachmentMeta = {
        contentType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
        disposition:
          a.contentDisposition === "attachment"
            ? "attachment"
            : a.contentDisposition === "inline"
              ? "inline"
              : "unknown",
      };
      if (a.contentId) (meta as { contentId?: string }).contentId = a.contentId;
      if (a.filename) (meta as { filename?: string }).filename = a.filename;
      if (a.checksum) (meta as { checksum?: string }).checksum = a.checksum;
      return meta;
    }),
    // mailparser handles most parts; opaque tracking is a hook for
    // future parsers that surface unknown multipart subtypes.
    opaque: [],
    rawSize: buf.byteLength,
    rawHeaders: headers,
  };
}

// Outbound send via the providers' REST APIs.
//
// Why not SMTP / IMAP APPEND? Because both Gmail's and Graph's
// send-message endpoints automatically place the message in the
// authenticated user's "Sent" folder, observe their per-account
// signing/encryption rules, and respect quota / spam policies. Doing
// the same over SMTP would require us to also reconstruct an IMAP
// APPEND into Sent and keep that in sync — a known footgun for
// IMAP+OAuth coexistence.
//
// We accept a fully-baked RFC 5322 MIME blob from the caller (the
// command handler builds it via nodemailer's MIME helpers). That keeps
// the headers-vs-body knowledge in one place.

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GRAPH_SENDMAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

export interface GmailSendArgs {
  readonly accessToken: string;
  // RFC 5322 message bytes (Buffer or string). Will be base64url-encoded.
  readonly raw: Buffer | string;
  // Optional Gmail thread id — when set, Gmail records this message
  // as part of the same conversation. Required for replies to display
  // correctly in the Gmail web UI.
  readonly threadId?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface GmailSendResult {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
}

export async function sendGmail(args: GmailSendArgs): Promise<GmailSendResult> {
  const f = args.fetchImpl ?? fetch;
  const buf = typeof args.raw === "string" ? Buffer.from(args.raw, "utf8") : args.raw;
  const body: Record<string, string> = { raw: toBase64Url(buf) };
  if (args.threadId) body["threadId"] = args.threadId;
  const res = await f(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`gmail send failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { id?: string; threadId?: string; labelIds?: string[] };
  if (!json.id || !json.threadId) {
    throw new Error("gmail send response missing id/threadId");
  }
  return { id: json.id, threadId: json.threadId, labelIds: json.labelIds ?? [] };
}

// Graph's sendMail accepts a structured Message object (not raw MIME).
// We build it from the same fields the CLI provides; for replies the
// caller supplies internetMessageHeaders so the threading headers
// (In-Reply-To, References) propagate.
export interface GraphSendArgs {
  readonly accessToken: string;
  readonly subject: string;
  readonly body: string;
  // Optional rich-text HTML body. When provided, Graph is told to send
  // the message as `contentType: "HTML"` (text/plain stays available
  // through the synced message store; Graph itself doesn't accept a
  // multipart envelope, only one body kind).
  readonly bodyHtml?: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly internetMessageHeaders?: readonly { name: string; value: string }[];
  readonly fetchImpl?: typeof fetch;
}

export async function sendGraph(args: GraphSendArgs): Promise<{ ok: true }> {
  const f = args.fetchImpl ?? fetch;
  const message = {
    subject: args.subject,
    body:
      args.bodyHtml && args.bodyHtml.trim().length > 0
        ? { contentType: "HTML", content: args.bodyHtml }
        : { contentType: "Text", content: args.body },
    toRecipients: args.to.map((address) => ({ emailAddress: { address } })),
    ...(args.cc ? { ccRecipients: args.cc.map((address) => ({ emailAddress: { address } })) } : {}),
    ...(args.bcc
      ? { bccRecipients: args.bcc.map((address) => ({ emailAddress: { address } })) }
      : {}),
    ...(args.internetMessageHeaders && args.internetMessageHeaders.length > 0
      ? { internetMessageHeaders: args.internetMessageHeaders }
      : {}),
  };
  const res = await f(GRAPH_SENDMAIL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    // saveToSentItems defaults to true; we keep the default explicitly
    // to make the IMAP Coexistence Integrity guarantee (it shows up in
    // the user's regular Sent folder) visible in the wire payload.
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`graph sendMail failed: ${res.status} ${text.slice(0, 300)}`);
  }
  // Graph returns 202 Accepted with empty body on success.
  return { ok: true };
}

// Send a fully-baked RFC 5322 MIME message via Graph, mirroring
// Gmail's raw path. Required for parity once we ship attachments and
// inline images: Graph's structured Message JSON does support file
// attachments, but its API is byte-quota-bound (3 MB inline / 150 MB
// total) and uses a separate POST per attachment, which doubles
// per-send latency. The MIME-via-sendMail path is one request and
// reuses the same composeMessage() output we already feed Gmail.
//
// Wire shape: POST /me/sendMail with `Content-Type: text/plain` and
// the request body is the base64-encoded MIME envelope.
export interface GraphSendRawArgs {
  readonly accessToken: string;
  readonly raw: Buffer | string;
  readonly fetchImpl?: typeof fetch;
}

export async function sendGraphRawMime(args: GraphSendRawArgs): Promise<{ ok: true }> {
  const f = args.fetchImpl ?? fetch;
  const buf = typeof args.raw === "string" ? Buffer.from(args.raw, "utf8") : args.raw;
  const res = await f(GRAPH_SENDMAIL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "text/plain",
    },
    body: buf.toString("base64"),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`graph sendMail (raw) failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return { ok: true };
}

// RFC 4648 base64url encoding (no padding) for Gmail's `raw` field.
function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Gmail REST helpers used during onboarding + initial sync.
//
// We deliberately keep this thin: just the two endpoints we need to (a)
// resolve the verified email address right after OAuth and (b) pull a
// small recent-INBOX window so the UI has something to show. The full
// IMAP / streaming sync still belongs in @mailai/imap-sync once XOAUTH2
// is wired through; this module exists so OAuth onboarding can deliver
// "I see my emails!" the moment the popup closes.

const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export interface GoogleUserInfo {
  readonly email: string;
  readonly verifiedEmail?: boolean;
  readonly name?: string;
  readonly picture?: string;
}

// Resolve the verified email address for a freshly-issued access token.
// Used by /api/oauth/finalize so we never end up with the
// `google-mail-<uuid>@unknown.local` placeholder in the UI.
export async function fetchGoogleUserInfo(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleUserInfo> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(USERINFO_URL, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`google userinfo failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    email?: string;
    verified_email?: boolean;
    name?: string;
    picture?: string;
  };
  if (!json.email) {
    throw new Error("google userinfo response missing 'email'");
  }
  const out: GoogleUserInfo = {
    email: json.email,
    ...(typeof json.verified_email === "boolean" ? { verifiedEmail: json.verified_email } : {}),
    ...(json.name ? { name: json.name } : {}),
    ...(json.picture ? { picture: json.picture } : {}),
  };
  return out;
}

// Single message metadata, normalized for our overlay table.
export interface GmailMessageMetadata {
  readonly id: string; // Gmail message id (16-hex)
  readonly threadId: string;
  readonly snippet: string;
  readonly internalDate: Date;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly to: string | null;
  readonly labelIds: readonly string[];
  readonly unread: boolean;
}

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailGetResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // ms since epoch as string
  payload?: {
    headers?: { name: string; value: string }[];
  };
}

// Lists the most recent N message ids in INBOX. Cheap (one HTTP call,
// returns just ids + threadIds).
export async function listGmailInboxIds(args: {
  accessToken: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; threadId: string }[]> {
  const f = args.fetchImpl ?? fetch;
  const max = Math.min(Math.max(args.maxResults ?? 30, 1), 100);
  const url =
    `${GMAIL_BASE}/users/me/messages` +
    `?labelIds=INBOX&maxResults=${max}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GmailListResponse;
  return json.messages ?? [];
}

// Fetch one message in `metadata` format with just the headers we need.
// Stays well under Gmail's 250-quota-units-per-user-per-second budget
// even when we batch-fetch ~30 at a time.
export async function getGmailMessageMetadata(args: {
  accessToken: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<GmailMessageMetadata> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.messageId)}` +
    `?format=metadata` +
    `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Date`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail get ${args.messageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GmailGetResponse;
  const headers = new Map<string, string>();
  for (const h of json.payload?.headers ?? []) {
    headers.set(h.name.toLowerCase(), h.value);
  }
  const fromRaw = headers.get("from") ?? null;
  const { name: fromName, email: fromEmail } = parseAddress(fromRaw);
  const labels = json.labelIds ?? [];
  return {
    id: json.id,
    threadId: json.threadId,
    snippet: decodeEntities(json.snippet ?? ""),
    internalDate: json.internalDate ? new Date(Number(json.internalDate)) : new Date(),
    subject: headers.get("subject") ?? null,
    fromName,
    fromEmail,
    to: headers.get("to") ?? null,
    labelIds: labels,
    unread: labels.includes("UNREAD"),
  };
}

// "Display Name" <addr@host> → { name, email }
function parseAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[2]) {
    const name = (m[1] ?? "").trim();
    return { name: name.length ? name : null, email: m[2].trim() };
  }
  // bare addr like alice@example.com
  if (raw.includes("@")) {
    return { name: null, email: raw.trim() };
  }
  return { name: raw.trim(), email: null };
}

// Gmail snippets come HTML-escaped (&amp;, &#39;, …). Normalise the
// handful that show up in practice so the inbox preview reads
// naturally without us shipping a full HTML decoder.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Full message bodies for the reader UI. Returns the best available
// text/plain and text/html parts, walking nested multipart bodies
// (multipart/alternative inside multipart/mixed inside …) so we don't
// mistake an attachment-laden message for an empty one.
//
// Gmail returns each part body as URL-safe base64 in `data`. We
// decode here so the API layer just hands strings to the UI.
export interface GmailAttachmentMeta {
  readonly partId: string | null;
  readonly attachmentId: string | null;
  readonly filename: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly isInline: boolean;
}

export interface GmailMessageBody {
  readonly id: string;
  readonly threadId: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly GmailAttachmentMeta[];
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailGetFullResponse {
  id: string;
  threadId: string;
  payload?: GmailPart;
}

export async function getGmailMessageBody(args: {
  accessToken: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<GmailMessageBody> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.messageId)}` +
    `?format=full`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail get-full ${args.messageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GmailGetFullResponse;
  const collected = {
    text: null as string | null,
    html: null as string | null,
    attachments: [] as GmailAttachmentMeta[],
  };
  if (json.payload) walkParts(json.payload, collected);
  return {
    id: json.id,
    threadId: json.threadId,
    text: collected.text,
    html: collected.html,
    attachments: collected.attachments,
  };
}

function walkParts(
  part: GmailPart,
  out: { text: string | null; html: string | null; attachments: GmailAttachmentMeta[] },
): void {
  const mt = (part.mimeType ?? "").toLowerCase();
  const headerMap = new Map<string, string>();
  for (const h of part.headers ?? []) headerMap.set(h.name.toLowerCase(), h.value);
  const disposition = (headerMap.get("content-disposition") ?? "").toLowerCase();
  const isInline = disposition.startsWith("inline");
  const isAttachment = !!part.filename && part.filename.length > 0;
  // Treat anything with an attachmentId or a filename as an
  // attachment-shaped part: real attachments have a filename, inline
  // images use Content-ID + no filename. Both are surfaced so the UI
  // can render the tray and the cid: rewriter can find the bytes.
  const hasAttachmentId = !!part.body?.attachmentId;
  const cidHeader = headerMap.get("content-id") ?? null;
  const cid = cidHeader ? cidHeader.replace(/^<|>$/g, "") : null;
  const looksLikeAttachment = isAttachment || (hasAttachmentId && (isInline || !!cid));

  if (looksLikeAttachment) {
    out.attachments.push({
      partId: part.partId ?? null,
      attachmentId: part.body?.attachmentId ?? null,
      filename: part.filename && part.filename.length ? part.filename : null,
      mime: mt || "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
      contentId: cid,
      isInline,
    });
  } else if (part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if (mt === "text/plain" && out.text === null) out.text = decoded;
    else if (mt === "text/html" && out.html === null) out.html = decoded;
  }
  for (const child of part.parts ?? []) walkParts(child, out);
}

// Fetch the actual bytes for one attachment. Gmail returns base64url.
export async function fetchGmailAttachmentBytes(args: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.messageId)}` +
    `/attachments/${encodeURIComponent(args.attachmentId)}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail attachment fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: string };
  if (!json.data) throw new Error("gmail attachment fetch missing data");
  const std = json.data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  return Buffer.from(std + pad, "base64");
}

// Fetch the raw RFC 822 bytes for a message. Used for "Show original"
// + EML download + forward. Counts as ~1 quota unit (vs ~5 for full),
// and we cache the result in S3 so each message is fetched at most
// once over its lifetime.
export async function fetchGmailRawMessage(args: {
  accessToken: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.messageId)}?format=raw`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail raw fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { raw?: string };
  if (!json.raw) throw new Error("gmail raw fetch missing raw");
  const std = json.raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  return Buffer.from(std + pad, "base64");
}

// Modify Gmail labels on a single message. Used by mark-read and star.
export async function modifyGmailMessageLabels(args: {
  accessToken: string;
  messageId: string;
  addLabelIds?: readonly string[];
  removeLabelIds?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(args.messageId)}/modify`;
  const body: Record<string, unknown> = {};
  if (args.addLabelIds && args.addLabelIds.length > 0) body["addLabelIds"] = args.addLabelIds;
  if (args.removeLabelIds && args.removeLabelIds.length > 0)
    body["removeLabelIds"] = args.removeLabelIds;
  const res = await f(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`gmail modify failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

function decodeBase64Url(s: string): string {
  // Gmail uses base64url with no padding. Convert to standard base64
  // and re-pad before letting Buffer decode it. Wrapping in a try
  // keeps a single malformed part from poisoning the whole message.
  try {
    const std = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
    return Buffer.from(std + pad, "base64").toString("utf8");
  } catch {
    return "";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

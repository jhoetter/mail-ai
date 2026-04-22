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
  // Raw header values, comma-separated (RFC822 syntax). The adapter
  // splits these into NormalizedAddress arrays via parseAddressList.
  readonly cc: string | null;
  readonly bcc: string | null;
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
// returns just ids + threadIds). Kept as a thin convenience wrapper
// over `listGmailMessageIds` so existing callers keep working.
export async function listGmailInboxIds(args: {
  accessToken: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; threadId: string }[]> {
  const page = await listGmailMessageIds({
    accessToken: args.accessToken,
    labelIds: ["INBOX"],
    ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  return page.messages;
}

// Provider-neutral page primitive. The adapter calls this with a
// specific labelId per folder (INBOX / SENT / DRAFT / TRASH / SPAM)
// and threads the pageToken through its own cursor.
export interface GmailMessageIdPage {
  readonly messages: { id: string; threadId: string }[];
  readonly nextPageToken: string | null;
}

export async function listGmailMessageIds(args: {
  accessToken: string;
  labelIds: ReadonlyArray<string>;
  maxResults?: number;
  pageToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<GmailMessageIdPage> {
  const f = args.fetchImpl ?? fetch;
  // Gmail caps `maxResults` at 500 but the realistic safe page size
  // is 100 — anything more risks downstream metadata fan-out timing
  // out. Mirrors the Graph cap so callers can pass the same value.
  const max = Math.min(Math.max(args.maxResults ?? 100, 1), 100);
  const params = new URLSearchParams();
  params.set("maxResults", String(max));
  for (const l of args.labelIds) params.append("labelIds", l);
  if (args.pageToken) params.set("pageToken", args.pageToken);
  const url = `${GMAIL_BASE}/users/me/messages?${params.toString()}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GmailListResponse;
  return {
    messages: json.messages ?? [],
    nextPageToken: json.nextPageToken ?? null,
  };
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
    `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To` +
    `&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Date`;
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
    cc: headers.get("cc") ?? null,
    bcc: headers.get("bcc") ?? null,
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

// Comma-separated address-list parser tolerant of quoted display
// names that themselves contain commas (e.g. `"Doe, John"
// <john@example.com>, jane@example.com`). We walk the string and
// only treat a comma as a delimiter when we are NOT inside double
// quotes or angle brackets — anything else is a string-split bug
// waiting to happen on real-world senders. Adapters call this on
// the raw `to`/`cc`/`bcc` headers we kept around for Reply All.
export function splitAddressList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

export function parseAddressList(
  raw: string | null,
): Array<{ name: string | null; email: string }> {
  const out: Array<{ name: string | null; email: string }> = [];
  for (const part of splitAddressList(raw)) {
    const { name, email } = parseAddress(part);
    if (email) out.push({ name, email });
  }
  return out;
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

// users.history.list response. Each history record has *one* event
// type populated (messagesAdded / messagesDeleted / labelsAdded /
// labelsRemoved). We only model the fields the delta walker uses;
// anything else stays untyped to keep the surface honest.
export interface GmailHistoryEvent {
  readonly id: string;
  readonly messages?: ReadonlyArray<{ id: string; threadId?: string }>;
  readonly messagesAdded?: ReadonlyArray<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
  readonly messagesDeleted?: ReadonlyArray<{ message: { id: string; threadId?: string } }>;
  readonly labelsAdded?: ReadonlyArray<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
  readonly labelsRemoved?: ReadonlyArray<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
}

export interface GmailHistoryPage {
  readonly history: ReadonlyArray<GmailHistoryEvent>;
  readonly historyId: string;
  readonly nextPageToken: string | null;
}

// One page of Gmail history events since the supplied watermark.
// Returns at most ~500 events per page; callers loop on
// nextPageToken until exhausted.
//
// HTTP 404 is the documented signal that the watermark is older than
// Gmail's retention window (~7 days). We surface it as a typed error
// so the adapter can drop the watermark and fall back to a full
// listMessages walk on the next sync.
export class GmailHistoryExpiredError extends Error {
  constructor(public readonly historyId: string) {
    super(`gmail history watermark ${historyId} expired (404)`);
    this.name = "GmailHistoryExpiredError";
  }
}

export async function listGmailHistory(args: {
  accessToken: string;
  startHistoryId: string;
  pageToken?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<GmailHistoryPage> {
  const f = args.fetchImpl ?? fetch;
  const max = Math.min(Math.max(args.maxResults ?? 500, 1), 500);
  const params = new URLSearchParams();
  params.set("startHistoryId", args.startHistoryId);
  params.set("maxResults", String(max));
  // We care about every flavour of change; missing types here would
  // silently hide events and let the local mirror drift.
  params.append("historyTypes", "messageAdded");
  params.append("historyTypes", "messageDeleted");
  params.append("historyTypes", "labelAdded");
  params.append("historyTypes", "labelRemoved");
  if (args.pageToken) params.set("pageToken", args.pageToken);
  const url = `${GMAIL_BASE}/users/me/history?${params.toString()}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (res.status === 404) {
    throw new GmailHistoryExpiredError(args.startHistoryId);
  }
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail history failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    history?: GmailHistoryEvent[];
    historyId?: string;
    nextPageToken?: string;
  };
  return {
    history: json.history ?? [],
    historyId: json.historyId ?? args.startHistoryId,
    nextPageToken: json.nextPageToken ?? null,
  };
}

// Cheapest way to get the current historyId without listing any
// messages: GET /users/me returns the mailbox's current historyId.
// Used to baseline a freshly-connected account so the *next* sync
// can pull a real delta.
export async function getGmailMailboxHistoryId(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const f = args.fetchImpl ?? fetch;
  const url = `${GMAIL_BASE}/users/me/profile`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`gmail profile failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { historyId?: string };
  if (!json.historyId) {
    throw new Error("gmail profile response missing 'historyId'");
  }
  return json.historyId;
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

// users.watch — register a Cloud Pub/Sub topic to receive history
// notifications. Gmail caps the watch lifetime at 7 days; the
// returned `expiration` is the UTC ms-since-epoch deadline by which
// we have to call watch() again to keep notifications flowing.
//
// `topicName` is the fully-qualified Pub/Sub topic
// (`projects/<project>/topics/<topic>`); `labelIds` is optional and
// when present scopes notifications to those labels. We default to
// INBOX so the scheduler doesn't get woken up by every CHAT message.
export interface GmailWatchResponse {
  readonly historyId: string;
  // Milliseconds since epoch (Gmail returns it as a string).
  readonly expiration: number;
}

export async function watchGmailMailbox(args: {
  accessToken: string;
  topicName: string;
  labelIds?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<GmailWatchResponse> {
  const f = args.fetchImpl ?? fetch;
  const url = `${GMAIL_BASE}/users/me/watch`;
  const body: Record<string, unknown> = {
    topicName: args.topicName,
    // labelFilterAction defaults to INCLUDE in v1; we set it
    // explicitly so the request semantics survive an API default
    // flip.
    labelFilterAction: "include",
    labelIds: args.labelIds && args.labelIds.length > 0 ? args.labelIds : ["INBOX"],
  };
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
    throw new Error(`gmail watch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { historyId?: string; expiration?: string };
  if (!json.historyId || !json.expiration) {
    throw new Error("gmail watch response missing historyId/expiration");
  }
  const expiration = Number(json.expiration);
  if (!Number.isFinite(expiration)) {
    throw new Error(`gmail watch returned non-numeric expiration: ${json.expiration}`);
  }
  return { historyId: json.historyId, expiration };
}

// users.stop — tear down an active watch. Idempotent: a 404 means
// the watch already lapsed, which is the same outcome we wanted.
export async function stopGmailMailboxWatch(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const url = `${GMAIL_BASE}/users/me/stop`;
  const res = await f(url, {
    method: "POST",
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`gmail stop failed: ${res.status} ${text.slice(0, 200)}`);
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

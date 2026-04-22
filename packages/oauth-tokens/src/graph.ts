// Microsoft Graph helpers used during onboarding + initial sync.
//
// Mirror of gmail.ts: just enough surface to (a) resolve the verified
// mailbox address right after OAuth and (b) pull a small recent-INBOX
// window so the user has something to see. Full sync still belongs in
// @mailai/imap-sync once XOAUTH2 is wired through.

const ME_URL = "https://graph.microsoft.com/v1.0/me";
const MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages";

export interface MicrosoftUserInfo {
  readonly email: string;
  readonly name?: string;
}

// Resolves the user's primary mailbox address. Graph returns it under
// `mail` for work/school accounts, falling back to `userPrincipalName`
// for personal accounts where `mail` is sometimes null.
export async function fetchMicrosoftUserInfo(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MicrosoftUserInfo> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(ME_URL, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph /me failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };
  const email = json.mail || json.userPrincipalName;
  if (!email) {
    throw new Error("graph /me response missing mail / userPrincipalName");
  }
  const out: MicrosoftUserInfo = {
    email,
    ...(json.displayName ? { name: json.displayName } : {}),
  };
  return out;
}

export interface GraphMessageMetadata {
  readonly id: string;
  readonly threadId: string; // conversationId
  readonly snippet: string; // bodyPreview
  readonly internalDate: Date; // receivedDateTime
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly to: string | null;
  readonly labelIds: readonly string[]; // categories
  readonly unread: boolean;
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime?: string | null;
  isRead?: boolean;
  categories?: string[];
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
}

interface GraphMessagesResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
}

// Lists the most recent N INBOX messages, already including the
// metadata we want. One HTTP call total — Graph is friendlier than
// Gmail for the "list + tiny preview" shape.
export async function listGraphInboxMessages(args: {
  accessToken: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<GraphMessageMetadata[]> {
  const f = args.fetchImpl ?? fetch;
  const top = Math.min(Math.max(args.maxResults ?? 30, 1), 100);
  const url =
    `${MESSAGES_URL}?$top=${top}` +
    `&$orderby=receivedDateTime desc` +
    `&$select=id,conversationId,subject,bodyPreview,receivedDateTime,isRead,categories,from,toRecipients`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph messages list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GraphMessagesResponse;
  const items = json.value ?? [];
  return items.map(toMetadata);
}

function toMetadata(m: GraphMessage): GraphMessageMetadata {
  const fromName = m.from?.emailAddress?.name ?? null;
  const fromEmail = m.from?.emailAddress?.address ?? null;
  const to =
    (m.toRecipients ?? [])
      .map((r) => r.emailAddress?.address)
      .filter((s): s is string => !!s)
      .join(", ") || null;
  const date = m.receivedDateTime ? new Date(m.receivedDateTime) : new Date();
  return {
    id: m.id,
    threadId: m.conversationId,
    snippet: m.bodyPreview ?? "",
    internalDate: date,
    subject: m.subject ?? null,
    fromName: fromName && fromName.length ? fromName : null,
    fromEmail,
    to,
    labelIds: m.categories ?? [],
    unread: m.isRead === false,
  };
}

// Full body for a single Graph message. Microsoft returns ONE body,
// either `text` or `html`, controlled by the `Prefer:
// outlook.body-content-type=...` header. We ask for HTML (the
// reader's preferred shape) and let the API caller derive a
// text fallback if needed.
//
// Note: Graph also exposes `uniqueBody` which strips the quoted
// reply chain; we use the full `body` so the reader can decide
// whether to collapse quoted text itself.
export interface GraphAttachmentMeta {
  readonly providerAttachmentId: string;
  readonly filename: string | null;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly isInline: boolean;
}

export interface GraphMessageBody {
  readonly id: string;
  readonly threadId: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly GraphAttachmentMeta[];
}

interface GraphAttachmentResponse {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
}

interface GraphMessageBodyResponse {
  id: string;
  conversationId: string;
  body?: { contentType?: "text" | "html"; content?: string | null };
  attachments?: GraphAttachmentResponse[];
}

export async function getGraphMessageBody(args: {
  accessToken: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<GraphMessageBody> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.messageId)}` +
    `?$select=id,conversationId,body` +
    `&$expand=attachments($select=id,name,contentType,size,isInline,contentId)`;
  const res = await f(url, {
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      prefer: 'outlook.body-content-type="html"',
    },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph get ${args.messageId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GraphMessageBodyResponse;
  const ct = json.body?.contentType ?? "text";
  const content = json.body?.content ?? null;
  const atts: GraphAttachmentMeta[] = (json.attachments ?? []).map((a) => ({
    providerAttachmentId: a.id,
    filename: a.name && a.name.length ? a.name : null,
    mime: a.contentType ?? "application/octet-stream",
    sizeBytes: a.size ?? 0,
    contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
    isInline: a.isInline === true,
  }));
  return {
    id: json.id,
    threadId: json.conversationId,
    text: ct === "text" ? content : null,
    html: ct === "html" ? content : null,
    attachments: atts,
  };
}

// Fetch the actual bytes for one Graph attachment. We bypass the
// FileAttachment json shape (which would force a base64 decode of a
// >100MB string) by hitting the `/$value` raw stream endpoint. For
// ItemAttachment / ReferenceAttachment kinds Graph returns an error
// here; the caller should treat it as "binary not available" and
// surface the metadata-only row.
export async function fetchGraphAttachmentBytes(args: {
  accessToken: string;
  messageId: string;
  attachmentId: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.messageId)}` +
    `/attachments/${encodeURIComponent(args.attachmentId)}/$value`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph attachment fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// Raw RFC 822 bytes for a Graph message (`/$value` on the message
// resource). Used for "Show original" + EML download + forward.
export async function fetchGraphRawMessage(args: {
  accessToken: string;
  messageId: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.messageId)}/$value`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph raw fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// PATCH a Graph message: used for mark-read (`isRead`) and star
// (`flag.flagStatus`). Graph rejects unknown fields, so callers pass
// only the keys they want to flip.
export async function patchGraphMessage(args: {
  accessToken: string;
  messageId: string;
  patch: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const url =
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.messageId)}`;
  const res = await f(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args.patch),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`graph patch failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

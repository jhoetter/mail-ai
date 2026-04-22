// Microsoft Graph helpers used during onboarding + initial sync.
//
// Mirror of gmail.ts: just enough surface to (a) resolve the verified
// mailbox address right after OAuth and (b) pull a small recent-INBOX
// window so the user has something to see. Full sync still belongs in
// @mailai/imap-sync once XOAUTH2 is wired through.

const ME_URL = "https://graph.microsoft.com/v1.0/me";
const MAIL_FOLDERS_BASE = "https://graph.microsoft.com/v1.0/me/mailFolders";

const GRAPH_MESSAGE_SELECT =
  "id,conversationId,subject,bodyPreview,receivedDateTime," +
  "isRead,categories,from,toRecipients,parentFolderId";

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
// Gmail for the "list + tiny preview" shape. Convenience wrapper
// around `listGraphFolderMessages`.
export async function listGraphInboxMessages(args: {
  accessToken: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<GraphMessageMetadata[]> {
  const page = await listGraphFolderMessages({
    accessToken: args.accessToken,
    folderId: "Inbox",
    ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  return page.messages;
}

export interface GraphMessagesPage {
  readonly messages: GraphMessageMetadata[];
  // Graph's @odata.nextLink is an absolute URL (with $skiptoken etc).
  // We surface it verbatim; callers thread it back via `nextLink`.
  readonly nextLink: string | null;
}

// Lists messages in any well-known or user-defined Graph mail folder
// (Inbox / SentItems / Drafts / DeletedItems / JunkEmail / Archive,
// or a folder GUID). Pagination is via the absolute `@odata.nextLink`
// URL Graph returns; the caller passes it back as `nextLink` on the
// next call.
export async function listGraphFolderMessages(args: {
  accessToken: string;
  folderId: string;
  maxResults?: number;
  nextLink?: string;
  fetchImpl?: typeof fetch;
}): Promise<GraphMessagesPage> {
  const f = args.fetchImpl ?? fetch;
  const top = Math.min(Math.max(args.maxResults ?? 100, 1), 100);
  const url = args.nextLink
    ? args.nextLink
    : `${MAIL_FOLDERS_BASE}/${encodeURIComponent(args.folderId)}/messages` +
      `?$top=${top}` +
      `&$orderby=receivedDateTime desc` +
      `&$select=${encodeURIComponent(GRAPH_MESSAGE_SELECT)}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph messages list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GraphMessagesResponse;
  return {
    messages: (json.value ?? []).map(toMetadata),
    nextLink: json["@odata.nextLink"] ?? null,
  };
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

// Microsoft Graph delta query for messages in a single folder.
// Returns a normalized page plus either a `nextLink` (more pages of
// changes left in this round) or a `deltaLink` (round complete; pass
// it back next time to get only changes since now).
//
// `@removed` entries are surfaced as `removedIds`. Graph emits these
// with a `@removed: { reason: "deleted" | "changed" }` annotation;
// we treat both as deletions because the message is no longer in
// the folder we're tracking.
export interface GraphDeltaPage {
  readonly messages: GraphMessageMetadata[];
  readonly removedIds: ReadonlyArray<string>;
  readonly nextLink: string | null;
  readonly deltaLink: string | null;
}

interface GraphDeltaResponse {
  value?: Array<
    GraphMessage & {
      "@removed"?: { reason?: string };
    }
  >;
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// 410 Gone is the documented signal that a deltaLink expired (Graph
// retains them ~30 days). We surface as a typed error so the adapter
// can drop the watermark and re-baseline next sync.
export class GraphDeltaExpiredError extends Error {
  constructor(public readonly deltaLink: string) {
    super(`graph deltaLink expired (410)`);
    this.name = "GraphDeltaExpiredError";
  }
}

export async function listGraphFolderMessagesDelta(args: {
  accessToken: string;
  // Either a folderId (kicks off a fresh delta round) or a previous
  // nextLink/deltaLink to continue. Caller chooses; passing both is
  // an error.
  folderId?: string;
  resumeLink?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): Promise<GraphDeltaPage> {
  if (!args.folderId && !args.resumeLink) {
    throw new Error("listGraphFolderMessagesDelta: pass folderId or resumeLink");
  }
  const f = args.fetchImpl ?? fetch;
  const top = Math.min(Math.max(args.maxResults ?? 100, 1), 100);
  const url =
    args.resumeLink ??
    `${MAIL_FOLDERS_BASE}/${encodeURIComponent(args.folderId!)}/messages/delta` +
      `?$top=${top}` +
      `&$select=${encodeURIComponent(GRAPH_MESSAGE_SELECT)}`;
  const res = await f(url, {
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (res.status === 410) {
    throw new GraphDeltaExpiredError(args.resumeLink ?? "");
  }
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`graph delta failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as GraphDeltaResponse;
  const messages: GraphMessageMetadata[] = [];
  const removedIds: string[] = [];
  for (const v of json.value ?? []) {
    if (v["@removed"]) {
      removedIds.push(v.id);
    } else {
      messages.push(toMetadata(v));
    }
  }
  return {
    messages,
    removedIds,
    nextLink: json["@odata.nextLink"] ?? null,
    deltaLink: json["@odata.deltaLink"] ?? null,
  };
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

// /me/subscriptions — Graph's webhook subscription surface. We only
// subscribe to the Inbox folder because (a) it's the mailbox the
// user actually wants near-realtime updates for and (b) Graph
// counts subscriptions per resource, so blanketing all folders
// would balloon the count.
//
// The Graph maximum lifetime for /messages is ~3 days; we ask for
// the full window and let the SyncScheduler renew before it
// expires. Graph echoes `clientState` back on every notification —
// we use it as the lookup key inside the webhook router so the
// public webhook URL doesn't need per-account secrets in the path.
export interface GraphSubscriptionResponse {
  readonly id: string;
  readonly expirationDateTime: string;
  readonly resource: string;
  readonly clientState: string | null;
}

const GRAPH_SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";

export async function createGraphMailSubscription(args: {
  accessToken: string;
  notificationUrl: string;
  clientState: string;
  // ISO timestamp; Graph rejects anything beyond the per-resource
  // ceiling (~3 days for /messages).
  expirationDateTime: string;
  // Folder to watch. Defaults to Inbox; callers can pass a folder
  // id for non-Inbox subscriptions.
  resource?: string;
  fetchImpl?: typeof fetch;
}): Promise<GraphSubscriptionResponse> {
  const f = args.fetchImpl ?? fetch;
  const body = {
    changeType: "created,updated,deleted",
    notificationUrl: args.notificationUrl,
    resource: args.resource ?? "me/mailFolders('Inbox')/messages",
    expirationDateTime: args.expirationDateTime,
    clientState: args.clientState,
  };
  const res = await f(GRAPH_SUBSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(
      `graph subscriptions create failed: ${res.status} ${text.slice(0, 400)}`,
    );
  }
  return (await res.json()) as GraphSubscriptionResponse;
}

// PATCH /subscriptions/{id} with a fresh expirationDateTime. Graph
// returns the updated subscription record; we surface only the
// fields the caller cares about.
export async function renewGraphMailSubscription(args: {
  accessToken: string;
  subscriptionId: string;
  expirationDateTime: string;
  fetchImpl?: typeof fetch;
}): Promise<GraphSubscriptionResponse> {
  const f = args.fetchImpl ?? fetch;
  const url = `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(args.subscriptionId)}`;
  const res = await f(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime: args.expirationDateTime }),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(
      `graph subscriptions renew failed: ${res.status} ${text.slice(0, 400)}`,
    );
  }
  return (await res.json()) as GraphSubscriptionResponse;
}

// DELETE /subscriptions/{id}. Idempotent: 404/410 ⇒ already gone.
export async function deleteGraphMailSubscription(args: {
  accessToken: string;
  subscriptionId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = args.fetchImpl ?? fetch;
  const url = `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(args.subscriptionId)}`;
  const res = await f(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return;
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(
      `graph subscriptions delete failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

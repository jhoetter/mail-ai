// GoogleMailAdapter — implements MailProvider against Gmail's REST API.
//
// Wraps the existing wire-level helpers in gmail.ts / send.ts. The
// adapter is stateless; the caller passes a fresh access token in
// per call (the registry hides token refresh from server handlers).
//
// Phase 2 establishes the surface: listFolders / listMessages
// stubs, fetchMessageBody / fetchRawMime / fetchAttachmentBytes /
// send / setRead / setStarred working through the existing
// helpers. Pagination over the Sent/Inbox window arrives in Phase
// 4 and the history-based pullDelta arrives in Phase 6 — those
// methods return safe defaults until then so the port stays
// shape-stable.

import {
  type AccessTokenArgs,
  type DeltaWatermark,
  type ListMessagesArgs,
  type ListMessagesPage,
  type MailProvider,
  type MailProviderCapabilities,
  type NormalizedAttachment,
  type NormalizedBody,
  type NormalizedFolder,
  type NormalizedMessage,
  type PullDeltaArgs,
  type PullDeltaResult,
  type SendResult,
  type WatermarkRow,
  type WellKnownFolder,
  type ComposedMessage,
} from "@mailai/providers";
import {
  fetchGmailAttachmentBytes,
  fetchGmailRawMessage,
  getGmailMailboxHistoryId,
  getGmailMessageBody,
  getGmailMessageMetadata,
  GmailHistoryExpiredError,
  listGmailHistory,
  listGmailMessageIds,
  modifyGmailMessageLabels,
  parseAddressList,
  type GmailMessageMetadata,
} from "../gmail.js";
import { sendGmail } from "../send.js";

// Gmail's well-known label ids map 1:1 to our wellKnownFolder
// values. UNREAD/STARRED/IMPORTANT/CHAT are flags, not folders, so
// they're not in this table — they're encoded into NormalizedMessage.flags.
const GMAIL_FOLDER_LABEL_IDS: Record<WellKnownFolder, string | null> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  // Gmail has no real "Archive" folder; an archived message is just
  // one without the INBOX label. We expose null so the scheduler
  // skips this folder for Gmail rather than emitting a doomed
  // request.
  archive: null,
  other: null,
};

// Phase 3 will route messages into a dedicated wellKnownFolder
// column. Until then, the adapter uses this lookup to assign each
// message a single folder bucket from its labelIds. INBOX wins
// over everything else so the inbox view stays populated even when
// a message is also tagged STARRED.
const WELL_KNOWN_PRIORITY: ReadonlyArray<{
  label: string;
  folder: WellKnownFolder;
}> = [
  { label: "TRASH", folder: "trash" },
  { label: "SPAM", folder: "spam" },
  { label: "DRAFT", folder: "drafts" },
  { label: "SENT", folder: "sent" },
  { label: "INBOX", folder: "inbox" },
];

// User labels (Gmail's CATEGORY_*, custom labels) are exposed
// untouched in NormalizedMessage.userLabels. System flags get
// stripped here so adapters never leak Gmail-specific tokens.
const SYSTEM_LABEL_IDS = new Set<string>([
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
]);

const CAPABILITIES: MailProviderCapabilities = {
  delta: true,
  push: true,
  synchronousSendId: true,
};

export class GoogleMailAdapter implements MailProvider {
  readonly id = "google-mail" as const;
  readonly capabilities: MailProviderCapabilities = CAPABILITIES;

  // listFolders is provider-static for Gmail: the well-known set is
  // always the same, the provider folder id is the label string.
  // The scheduler is the caller — Gmail's actual user-defined
  // labels live elsewhere and are not folders for our purposes.
  async listFolders(_args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedFolder>> {
    void _args;
    const out: NormalizedFolder[] = [];
    for (const [folder, labelId] of Object.entries(GMAIL_FOLDER_LABEL_IDS)) {
      if (!labelId) continue;
      out.push({
        wellKnownFolder: folder as WellKnownFolder,
        providerFolderId: labelId,
        displayName: labelId,
      });
    }
    return out;
  }

  // Lists one page of messages from the requested well-known folder.
  // Cursor is Gmail's `pageToken`. Sequential metadata fan-out is
  // fine at page-size 100 — well under Gmail's 250 quota-units /
  // user / second budget. The scheduler caller is responsible for
  // looping pages.
  async listMessages(
    args: AccessTokenArgs & ListMessagesArgs,
  ): Promise<ListMessagesPage> {
    const labelId = GMAIL_FOLDER_LABEL_IDS[args.folder];
    if (!labelId) {
      // Gmail has no native "Archive" folder (an archived message
      // is one without INBOX). Returning empty is the honest answer
      // until we add a `q=-label:INBOX` path.
      return { messages: [], nextCursor: null };
    }
    const page = await listGmailMessageIds({
      accessToken: args.accessToken,
      labelIds: [labelId],
      maxResults: args.pageSize,
      ...(args.cursor ? { pageToken: args.cursor } : {}),
    });
    const messages: NormalizedMessage[] = [];
    for (const ref of page.messages) {
      const meta = await getGmailMessageMetadata({
        accessToken: args.accessToken,
        messageId: ref.id,
      });
      messages.push(toNormalizedMessage(meta, args.folder));
    }
    return {
      messages,
      nextCursor: page.nextPageToken,
    };
  }

  async fetchMessageBody(
    args: AccessTokenArgs & { providerMessageId: string },
  ): Promise<NormalizedBody> {
    const body = await getGmailMessageBody({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
    });
    return {
      text: body.text,
      html: body.html,
      attachments: body.attachments.map((a) => ({
        providerAttachmentId: a.attachmentId,
        filename: a.filename ?? "",
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        contentId: a.contentId,
        isInline: a.isInline,
      })),
    };
  }

  async fetchRawMime(
    args: AccessTokenArgs & { providerMessageId: string },
  ): Promise<Buffer> {
    return fetchGmailRawMessage({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
    });
  }

  async fetchAttachmentBytes(
    args: AccessTokenArgs & {
      providerMessageId: string;
      attachment: NormalizedAttachment;
    },
  ): Promise<Buffer> {
    const id = args.attachment.providerAttachmentId;
    if (!id) {
      throw new Error(
        `google-mail adapter: attachment ${args.attachment.filename} has no providerAttachmentId`,
      );
    }
    return fetchGmailAttachmentBytes({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      attachmentId: id,
    });
  }

  async send(
    args: AccessTokenArgs & { message: ComposedMessage },
  ): Promise<SendResult> {
    const result = await sendGmail({
      accessToken: args.accessToken,
      raw: args.message.raw,
      ...(args.message.providerThreadId
        ? { threadId: args.message.providerThreadId }
        : {}),
    });
    return {
      providerMessageId: result.id,
      providerThreadId: result.threadId,
    };
  }

  async setRead(
    args: AccessTokenArgs & { providerMessageId: string; read: boolean },
  ): Promise<void> {
    await modifyGmailMessageLabels({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      ...(args.read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] }),
    });
  }

  async setStarred(
    args: AccessTokenArgs & { providerMessageId: string; starred: boolean },
  ): Promise<void> {
    await modifyGmailMessageLabels({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      ...(args.starred
        ? { addLabelIds: ["STARRED"] }
        : { removeLabelIds: ["STARRED"] }),
    });
  }

  // users.history.list-backed delta. Walks every history page since
  // the supplied watermark, materializes added/changed messages
  // through getGmailMessageMetadata so the result rows look exactly
  // like a listMessages page, and surfaces deleted ids verbatim.
  //
  // When `since` is null (first delta-capable sync), we just baseline
  // the watermark from /users/me/profile and return an empty result.
  // The scheduler then runs the regular listMessages walk on top of
  // that baseline; the next tick gets a real delta.
  //
  // 404 from Gmail means the watermark is older than ~7 days; we
  // return null nextWatermark so the scheduler clears the column and
  // re-baselines on the next call.
  async pullDelta(
    args: AccessTokenArgs & PullDeltaArgs,
  ): Promise<PullDeltaResult> {
    if (!args.since) {
      const historyId = await getGmailMailboxHistoryId({
        accessToken: args.accessToken,
      });
      return {
        inserted: [],
        updated: [],
        deleted: [],
        nextWatermark: { kind: "gmail", historyId },
      };
    }
    if (args.since.kind !== "gmail") {
      // Defensive: Gmail adapter never expects a Graph deltaLink.
      // Return empty so the caller falls back to listMessages.
      return { inserted: [], updated: [], deleted: [], nextWatermark: null };
    }

    const inserted = new Map<string, NormalizedMessage>();
    const updated = new Map<string, NormalizedMessage>();
    const deleted = new Set<string>();

    let cursor: string | undefined;
    let latestHistoryId = args.since.historyId;
    try {
      // Bound the walk so a runaway delta (e.g. account just emptied
      // its trash of 50k messages) can't pin the worker. 20 pages ×
      // 500 events ≈ 10k events; anything larger we'll catch on the
      // next tick.
      for (let page = 0; page < 20; page += 1) {
        const resp = await listGmailHistory({
          accessToken: args.accessToken,
          startHistoryId: args.since.historyId,
          ...(cursor ? { pageToken: cursor } : {}),
        });
        latestHistoryId = resp.historyId;

        for (const ev of resp.history) {
          for (const a of ev.messagesDeleted ?? []) {
            const id = a.message.id;
            deleted.add(id);
            // A delete trumps any earlier add/update for the same id
            // in this batch.
            inserted.delete(id);
            updated.delete(id);
          }
          for (const a of ev.messagesAdded ?? []) {
            const id = a.message.id;
            if (!deleted.has(id) && !inserted.has(id)) {
              inserted.set(id, /* placeholder */ {} as NormalizedMessage);
            }
          }
          for (const a of ev.labelsAdded ?? ev.labelsRemoved ?? []) {
            const id = a.message.id;
            if (!deleted.has(id) && !inserted.has(id) && !updated.has(id)) {
              updated.set(id, {} as NormalizedMessage);
            }
          }
        }

        if (!resp.nextPageToken) break;
        cursor = resp.nextPageToken;
      }
    } catch (err) {
      if (err instanceof GmailHistoryExpiredError) {
        // Watermark gone — caller will re-baseline.
        return {
          inserted: [],
          updated: [],
          deleted: [],
          nextWatermark: null,
        };
      }
      throw err;
    }

    // Materialize metadata for everything still in the add/update
    // sets. Sequential is fine at the bounded sizes above; if a
    // single id 404s the message was deleted between events and our
    // delete walk, which we treat as a delete.
    for (const id of [...inserted.keys()]) {
      try {
        const meta = await getGmailMessageMetadata({
          accessToken: args.accessToken,
          messageId: id,
        });
        inserted.set(id, toNormalizedMessage(meta));
      } catch {
        inserted.delete(id);
        deleted.add(id);
      }
    }
    for (const id of [...updated.keys()]) {
      try {
        const meta = await getGmailMessageMetadata({
          accessToken: args.accessToken,
          messageId: id,
        });
        updated.set(id, toNormalizedMessage(meta));
      } catch {
        updated.delete(id);
        deleted.add(id);
      }
    }

    return {
      inserted: [...inserted.values()],
      updated: [...updated.values()],
      deleted: [...deleted],
      nextWatermark: { kind: "gmail", historyId: latestHistoryId },
    };
  }

  readWatermark(row: WatermarkRow): DeltaWatermark | null {
    return row.historyId ? { kind: "gmail", historyId: row.historyId } : null;
  }
}

export function gmailLabelIdsToWellKnownFolder(
  labelIds: ReadonlyArray<string>,
): WellKnownFolder {
  const set = new Set(labelIds);
  for (const { label, folder } of WELL_KNOWN_PRIORITY) {
    if (set.has(label)) return folder;
  }
  return "other";
}

export function gmailLabelIdsToUserLabels(
  labelIds: ReadonlyArray<string>,
): string[] {
  return labelIds.filter((l) => !SYSTEM_LABEL_IDS.has(l));
}

function toNormalizedMessage(
  meta: GmailMessageMetadata,
  // The folder the caller queried. We trust this over labelIds because
  // a Gmail message can carry both INBOX and SENT (e.g. self-addressed
  // mail), and the scheduler wants a single bucket per row.
  queriedFolder: WellKnownFolder | null = null,
): NormalizedMessage {
  const flags: ("unread" | "starred" | "important")[] = [];
  if (meta.unread) flags.push("unread");
  if (meta.labelIds.includes("STARRED")) flags.push("starred");
  if (meta.labelIds.includes("IMPORTANT")) flags.push("important");
  return {
    providerMessageId: meta.id,
    providerThreadId: meta.threadId,
    wellKnownFolder:
      queriedFolder ?? gmailLabelIdsToWellKnownFolder(meta.labelIds),
    subject: meta.subject,
    from:
      meta.fromEmail !== null
        ? { name: meta.fromName, email: meta.fromEmail }
        : null,
    to: parseAddressList(meta.to),
    cc: parseAddressList(meta.cc),
    bcc: parseAddressList(meta.bcc),
    snippet: meta.snippet,
    internalDate: meta.internalDate,
    flags,
    hasAttachments: false,
    userLabels: gmailLabelIdsToUserLabels(meta.labelIds),
    rfc822MessageId: null,
  };
}

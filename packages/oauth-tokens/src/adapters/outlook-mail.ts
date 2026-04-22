// OutlookMailAdapter — implements MailProvider against Microsoft
// Graph mail. Mirrors GoogleMailAdapter; both adapters live next
// to their wire-level wrappers so wire details never leak past
// this folder.
//
// Graph's sendMail returns 202 Accepted with no body, so the
// returned providerMessageId is the locally-composed Message-ID
// header value. The Sent-mirror in the server handler relies on
// that to dedupe against the eventual real id during the next
// sync.

import {
  type AccessTokenArgs,
  type ComposedMessage,
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
} from "@mailai/providers";
import {
  fetchGraphAttachmentBytes,
  fetchGraphRawMessage,
  getGraphMessageBody,
  GraphDeltaExpiredError,
  listGraphFolderMessages,
  listGraphFolderMessagesDelta,
  patchGraphMessage,
  type GraphMessageMetadata,
} from "../graph.js";
import { sendGraphRawMime } from "../send.js";

// Graph's well-known folder names. The /me/mailFolders/{folderId}
// endpoint accepts these as folder ids — the actual GUID id is
// only required when targeting user-defined folders.
const GRAPH_FOLDER_IDS: Record<WellKnownFolder, string | null> = {
  inbox: "Inbox",
  sent: "SentItems",
  drafts: "Drafts",
  trash: "DeletedItems",
  spam: "JunkEmail",
  archive: "Archive",
  other: null,
};

const CAPABILITIES: MailProviderCapabilities = {
  delta: true,
  push: true,
  // Graph's sendMail returns 202 Accepted with no body, so the
  // adapter has to surface the locally-composed Message-ID
  // instead and rely on the next sync for the real id.
  synchronousSendId: false,
};

export class OutlookMailAdapter implements MailProvider {
  readonly id = "outlook" as const;
  readonly capabilities: MailProviderCapabilities = CAPABILITIES;

  async listFolders(_args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedFolder>> {
    void _args;
    const out: NormalizedFolder[] = [];
    for (const [folder, folderId] of Object.entries(GRAPH_FOLDER_IDS)) {
      if (!folderId) continue;
      out.push({
        wellKnownFolder: folder as WellKnownFolder,
        providerFolderId: folderId,
        displayName: folderId,
      });
    }
    return out;
  }

  async listMessages(
    args: AccessTokenArgs & ListMessagesArgs,
  ): Promise<ListMessagesPage> {
    const folderId = GRAPH_FOLDER_IDS[args.folder];
    if (!folderId) {
      // Folders we don't have a mapping for (e.g. "other") are an
      // empty list — the registry caller decides whether to skip
      // them upfront via listFolders().
      return { messages: [], nextCursor: null };
    }
    const page = await listGraphFolderMessages({
      accessToken: args.accessToken,
      folderId,
      maxResults: args.pageSize,
      ...(args.cursor ? { nextLink: args.cursor } : {}),
    });
    return {
      messages: page.messages.map((m) => toNormalizedMessage(m, args.folder)),
      nextCursor: page.nextLink,
    };
  }

  async fetchMessageBody(
    args: AccessTokenArgs & { providerMessageId: string },
  ): Promise<NormalizedBody> {
    const body = await getGraphMessageBody({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
    });
    return {
      text: body.text,
      html: body.html,
      attachments: body.attachments.map((a) => ({
        providerAttachmentId: a.providerAttachmentId,
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
    return fetchGraphRawMessage({
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
        `outlook adapter: attachment ${args.attachment.filename} has no providerAttachmentId`,
      );
    }
    return fetchGraphAttachmentBytes({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      attachmentId: id,
    });
  }

  async send(
    args: AccessTokenArgs & { message: ComposedMessage },
  ): Promise<SendResult> {
    await sendGraphRawMime({
      accessToken: args.accessToken,
      raw: args.message.raw,
    });
    return {
      providerMessageId: args.message.rfc822MessageId,
      providerThreadId: args.message.providerThreadId ?? null,
    };
  }

  async setRead(
    args: AccessTokenArgs & { providerMessageId: string; read: boolean },
  ): Promise<void> {
    await patchGraphMessage({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      patch: { isRead: args.read },
    });
  }

  async setStarred(
    args: AccessTokenArgs & { providerMessageId: string; starred: boolean },
  ): Promise<void> {
    await patchGraphMessage({
      accessToken: args.accessToken,
      messageId: args.providerMessageId,
      patch: { flag: { flagStatus: args.starred ? "flagged" : "notFlagged" } },
    });
  }

  // Microsoft Graph mailbox-wide delta isn't a thing in v1.0; the
  // delta endpoint is per-folder. We focus delta on the Inbox — by
  // far the most-watched folder — and let the regular listMessages
  // walk handle Sent/Drafts/Trash/Spam/Archive on the next tick.
  // The watermark is the Graph deltaLink for the Inbox round.
  //
  // 410 from Graph means the deltaLink expired (~30-day window). We
  // surface a null nextWatermark so the scheduler clears the column
  // and re-baselines on the next call.
  async pullDelta(
    args: AccessTokenArgs & PullDeltaArgs,
  ): Promise<PullDeltaResult> {
    if (args.since && args.since.kind !== "graph") {
      // Defensive: Graph adapter never expects a Gmail historyId.
      return { inserted: [], updated: [], deleted: [], nextWatermark: null };
    }

    let resumeLink: string | undefined = args.since?.deltaLink;
    let folderId: string | undefined = resumeLink ? undefined : "Inbox";
    const insertedOrUpdated: NormalizedMessage[] = [];
    const deletedIds: string[] = [];
    let finalDeltaLink: string | null = null;

    try {
      // Bound the walk so a runaway delta can't pin the worker.
      // 50 pages × 100 events ≈ 5k events; anything larger we'll
      // catch on the next tick.
      for (let page = 0; page < 50; page += 1) {
        const resp = await listGraphFolderMessagesDelta({
          accessToken: args.accessToken,
          ...(folderId ? { folderId } : {}),
          ...(resumeLink ? { resumeLink } : {}),
        });
        for (const m of resp.messages) {
          insertedOrUpdated.push(toNormalizedMessage(m, "inbox"));
        }
        for (const id of resp.removedIds) deletedIds.push(id);

        if (resp.deltaLink) {
          finalDeltaLink = resp.deltaLink;
          break;
        }
        if (!resp.nextLink) break;
        resumeLink = resp.nextLink;
        folderId = undefined;
      }
    } catch (err) {
      if (err instanceof GraphDeltaExpiredError) {
        return {
          inserted: [],
          updated: [],
          deleted: [],
          nextWatermark: null,
        };
      }
      throw err;
    }

    // Graph's delta doesn't tell us which entries are first-seen vs
    // updated. The repository upsert is idempotent on
    // (account, providerMessageId), so it's safe to put everything
    // in `updated` — the server-side count just tells the user
    // "N changed", which is honest.
    return {
      inserted: [],
      updated: insertedOrUpdated,
      deleted: deletedIds,
      nextWatermark: finalDeltaLink
        ? { kind: "graph", deltaLink: finalDeltaLink }
        : args.since ?? null,
    };
  }

  readWatermark(row: WatermarkRow): DeltaWatermark | null {
    return row.deltaLink ? { kind: "graph", deltaLink: row.deltaLink } : null;
  }
}

// Microsoft Graph encodes folder identity in `parentFolderId`, not in
// labels — but the existing wire-level helper exposes the well-known
// folder id strings (Inbox / SentItems / etc.) inside `labelIds` for
// historical reasons. We strip those so callers writing rows to
// oauth_messages.labels_json never end up with folder strings sneaking
// back in. Also strip `Categories` system tokens; user-defined Outlook
// categories pass through unchanged.
const GRAPH_FOLDER_TOKENS = new Set<string>([
  "Inbox",
  "SentItems",
  "Drafts",
  "DeletedItems",
  "JunkEmail",
  "Archive",
]);

export function graphLabelIdsToUserLabels(
  labelIds: ReadonlyArray<string>,
): string[] {
  return labelIds.filter((l) => !GRAPH_FOLDER_TOKENS.has(l));
}

function toNormalizedMessage(
  meta: GraphMessageMetadata,
  folder: WellKnownFolder,
): NormalizedMessage {
  const flags: ("unread" | "starred")[] = [];
  if (meta.unread) flags.push("unread");
  return {
    providerMessageId: meta.id,
    providerThreadId: meta.threadId,
    wellKnownFolder: folder,
    subject: meta.subject,
    from:
      meta.fromEmail !== null
        ? { name: meta.fromName, email: meta.fromEmail }
        : null,
    to: meta.to ? [{ name: null, email: meta.to }] : [],
    cc: [],
    snippet: meta.snippet,
    internalDate: meta.internalDate,
    flags,
    hasAttachments: false,
    userLabels: graphLabelIdsToUserLabels(meta.labelIds),
    rfc822MessageId: null,
  };
}

// MailProvider — the port every mail backend implements.
//
// Adapters live next to the wire-level clients they wrap (Gmail
// adapter alongside gmail.ts in @mailai/oauth-tokens; Outlook
// adapter alongside graph.ts; future IMAP adapter alongside
// @mailai/imap-sync). Server handlers and routes never import
// gmail.ts/graph.ts directly — they go through the registry +
// port instead, so the rest of the codebase has zero "if google
// else outlook" branches.
//
// The port is intentionally narrow: just the operations the inbox
// surface dispatches today (list, fetch, send, mark, star) plus
// the delta hook that the scheduler will lean on in Phase 6+.
// Capabilities are advertised via `capabilities`, so callers can
// gate UI without sniffing for method existence.

import type {
  ComposedMessage,
  DeltaWatermark,
  ListMessagesArgs,
  ListMessagesPage,
  NormalizedAccount,
  NormalizedAttachment,
  NormalizedBody,
  NormalizedFolder,
  NormalizedMessage,
  PullDeltaArgs,
  PullDeltaResult,
  SendResult,
} from "../types.js";

// Persisted columns the watermark reader needs. Matches the subset
// of OauthAccountRow that holds delta state — kept structural so
// @mailai/providers stays free of an overlay-db dependency.
export interface WatermarkRow {
  readonly historyId: string | null;
  readonly deltaLink: string | null;
}

export interface MailProviderCapabilities {
  // Whether the adapter exposes pullDelta() (true for Gmail
  // history, true for Graph delta tokens). When false, the
  // scheduler falls back to listMessages over a finite window.
  readonly delta: boolean;
  // Whether the adapter can subscribe to push notifications
  // (Phase 7). Stored here so the scheduler knows whether to
  // bother attempting subscribe().
  readonly push: boolean;
  // Whether the provider's send call returns the canonical
  // server-side message id synchronously. Gmail does; Graph
  // sendMail does not. Callers use this to decide whether to
  // wait for the next sync to learn the real id.
  readonly synchronousSendId: boolean;
}

export interface AccessTokenArgs {
  // Adapters never refresh tokens themselves; the caller passes a
  // valid access token in. Token refresh stays in
  // @mailai/oauth-tokens/refresher.ts and the registry hides it
  // behind a callback so adapters stay pure.
  readonly accessToken: string;
}

export interface MailProvider {
  readonly id: NormalizedAccount["provider"];
  readonly capabilities: MailProviderCapabilities;

  // Folder discovery. Used by the scheduler to translate a
  // wellKnownFolder set into provider folder ids before listing
  // messages. Adapters that have a fixed mapping (Gmail) just
  // hand back constants.
  listFolders(args: AccessTokenArgs): Promise<ReadonlyArray<NormalizedFolder>>;

  // List messages in a single folder, page by page. The caller is
  // responsible for paging until nextCursor is null.
  listMessages(args: AccessTokenArgs & ListMessagesArgs): Promise<ListMessagesPage>;

  // Lazy body fetch. Returns null/null body when the provider
  // genuinely has nothing for that id (rare).
  fetchMessageBody(args: AccessTokenArgs & { providerMessageId: string }): Promise<NormalizedBody>;

  // Raw RFC 822 bytes for download / forward / .eml export. Cached
  // by the caller in the object store; the adapter never caches.
  fetchRawMime(args: AccessTokenArgs & { providerMessageId: string }): Promise<Buffer>;

  // Lazy attachment fetch. Returns just the bytes; metadata comes
  // from the message body fetch (NormalizedBody is only the body
  // text/html, attachments hang off NormalizedMessage instead).
  fetchAttachmentBytes(
    args: AccessTokenArgs & {
      providerMessageId: string;
      attachment: NormalizedAttachment;
    },
  ): Promise<Buffer>;

  send(args: AccessTokenArgs & { message: ComposedMessage }): Promise<SendResult>;

  setRead(args: AccessTokenArgs & { providerMessageId: string; read: boolean }): Promise<void>;

  setStarred(
    args: AccessTokenArgs & { providerMessageId: string; starred: boolean },
  ): Promise<void>;

  // Delta sync — optional in spirit but always present on the
  // type so callers don't have to do shape-sniffing. Adapters
  // without delta return {inserted:[], updated:[], deleted:[],
  // nextWatermark:null} so the caller cleanly falls back to a
  // full listMessages walk.
  pullDelta(args: AccessTokenArgs & PullDeltaArgs): Promise<PullDeltaResult>;

  // Reconstruct the delta watermark this adapter cares about from
  // the persisted account row. Each adapter knows which column it
  // populates (Gmail → historyId, Graph → deltaLink); centralising
  // the read here keeps the scheduler from branching on
  // `account.provider`. Returns null when there is no usable
  // watermark and the caller should run a full listMessages walk.
  readWatermark(row: WatermarkRow): DeltaWatermark | null;

  // Message normalization is deliberately exposed so the
  // multi-folder sync (Phase 4) can pass a provider message
  // straight through into oauth_messages without re-walking the
  // network for each id. Adapters that don't have a stable
  // intermediate shape just curry over their listMessages output
  // (i.e. it's effectively the identity).
  // Kept on the port so contract tests can exercise normalization
  // in isolation against golden fixtures.
  normalize?(raw: unknown): NormalizedMessage;
}

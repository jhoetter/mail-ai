// Provider-neutral types that flow across the @mailai/providers
// package boundary. Anything an adapter consumes from a caller, or
// an adapter returns to a caller, has to be expressed in these
// types. Provider-specific shapes (Gmail label ids, Graph
// conversation ids, IMAP UIDs, etc.) stay inside the adapters.
//
// The discriminator everywhere is the existing `MailProviderId`
// union — same values stored in oauth_accounts.provider so adapters
// don't have to do a translation layer.

export type MailProviderId = "google-mail" | "outlook";

// Well-known folders are the *semantics* a generic mail surface
// cares about ("show me Sent"). Each adapter maps its
// provider-specific folder/label/category structure into one of
// these on the way out, and back into provider-specific terms on
// the way in. "other" is the catch-all for user-defined folders /
// custom Gmail labels — those keep their providerFolderId for
// adapter-side disambiguation but never get hard-coded in the UI.
export type WellKnownFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "trash"
  | "spam"
  | "archive"
  | "other";

// Per-message flags abstracted across providers. Gmail expresses
// these as label ids (UNREAD, STARRED, IMPORTANT, …); Graph as
// boolean fields (isRead, flag.flagStatus). Adapters translate.
export type MessageFlag = "unread" | "starred" | "important" | "answered";

export interface NormalizedAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: MailProviderId;
  readonly email: string;
}

export interface NormalizedFolder {
  readonly wellKnownFolder: WellKnownFolder;
  // The provider's own folder/label/category id for this folder.
  // Adapters use it to pass through to provider APIs without
  // re-translating semantics every call. `null` for synthetic
  // folders (e.g. Gmail's All Mail / archive view).
  readonly providerFolderId: string | null;
  // Human-friendly name as the provider reports it. Unused by the
  // generic UI today but useful for diagnostics + power-user labels.
  readonly displayName: string;
}

export interface NormalizedAddress {
  readonly name: string | null;
  readonly email: string;
}

// Body shape returned from the provider. Bodies are fetched
// lazily — the listMessages path only returns metadata.
//
// Attachments come back together with the body because both Gmail's
// `format=full` and Graph's `$expand=attachments` deliver them in
// the same API round-trip. Splitting them would double the cost of
// every reader open.
export interface NormalizedBody {
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: ReadonlyArray<NormalizedAttachment>;
}

export interface NormalizedAttachment {
  // Provider attachment id (Gmail attachmentId / Graph attachment id).
  // Adapters use this to fetch bytes lazily.
  readonly providerAttachmentId: string | null;
  readonly filename: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly contentId: string | null;
  readonly isInline: boolean;
}

export interface NormalizedMessage {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  // Where this message lives. Adapters MUST emit a wellKnownFolder
  // so the generic views can filter by it without re-implementing
  // provider folder semantics.
  readonly wellKnownFolder: WellKnownFolder;
  readonly subject: string | null;
  readonly from: NormalizedAddress | null;
  readonly to: ReadonlyArray<NormalizedAddress>;
  readonly cc: ReadonlyArray<NormalizedAddress>;
  readonly snippet: string;
  // RFC822 epoch the provider attaches to the message (Gmail
  // internalDate, Graph receivedDateTime). The Sent mirror uses
  // Date.now() instead, which is fine because these are eventually
  // overwritten by the next sync.
  readonly internalDate: Date;
  readonly flags: ReadonlyArray<MessageFlag>;
  readonly hasAttachments: boolean;
  // User labels / categories — anything that survives Phase 10's
  // label cleanup (i.e. NOT one of the well-known system folders).
  // Keeps the door open for the future label-chip UI.
  readonly userLabels: ReadonlyArray<string>;
  // RFC822 Message-ID header value (without the angle brackets).
  // Used for cross-provider dedupe when a message we just sent
  // shows up in a Sent folder sync.
  readonly rfc822MessageId: string | null;
}

// What the caller hands the adapter when sending. We keep the same
// shape we already feed `composeMessage()` so the existing MIME
// builder doesn't have to learn a new contract.
export interface ComposedMessage {
  // Already-rendered RFC 822 bytes. The adapter is responsible only
  // for transport — composition stays in @mailai/mime.
  readonly raw: Buffer;
  // RFC822 Message-ID header value (without angle brackets). Used
  // by the local Sent-mirror so a subsequent server sync can dedupe
  // against this row instead of inserting a duplicate.
  readonly rfc822MessageId: string;
  // Optional in-thread send (Gmail respects threadId; Graph keys
  // off In-Reply-To/References headers in the raw bytes itself).
  readonly providerThreadId?: string | undefined;
}

// Result of a send. providerMessageId is the authoritative id from
// the provider when one is returned synchronously (Gmail) — for
// Outlook's 202-no-body sendMail this is the locally-composed
// Message-ID and we reconcile during the next sync.
export interface SendResult {
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
}

export interface ListMessagesArgs {
  readonly folder: WellKnownFolder;
  readonly pageSize: number;
  // Opaque adapter cursor. null at the first page.
  readonly cursor: string | null;
}

export interface ListMessagesPage {
  readonly messages: ReadonlyArray<NormalizedMessage>;
  // Opaque adapter cursor for the next page; null when exhausted.
  readonly nextCursor: string | null;
}

// Watermarks for delta sync (Phase 6). Adapters that don't support
// delta return `kind: "none"` from pullDelta() and the scheduler
// falls back to listMessages.
export type DeltaWatermark =
  | { readonly kind: "gmail"; readonly historyId: string }
  | { readonly kind: "graph"; readonly deltaLink: string };

export interface PullDeltaArgs {
  readonly since: DeltaWatermark | null;
}

export interface PullDeltaResult {
  readonly inserted: ReadonlyArray<NormalizedMessage>;
  readonly updated: ReadonlyArray<NormalizedMessage>;
  // Provider message ids that the provider says were deleted since
  // the last watermark. The scheduler soft-deletes them locally.
  readonly deleted: ReadonlyArray<string>;
  readonly nextWatermark: DeltaWatermark | null;
}

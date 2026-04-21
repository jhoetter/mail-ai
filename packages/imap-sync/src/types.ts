// Shared types for the IMAP sync layer. We intentionally do NOT
// re-export imapflow types — keeps the boundary clean and lets us swap
// implementations later without touching overlay-db / collaboration.

export type Provider = "gmail" | "microsoft" | "imap";

export interface AccountCredentials {
  readonly provider: Provider;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly auth:
    | { kind: "password"; password: string }
    | { kind: "xoauth2"; accessToken: string; refreshToken: string; expiresAt: number };
}

export interface MailboxInfo {
  readonly path: string;
  readonly delimiter: string;
  readonly specialUse?: "\\Inbox" | "\\Sent" | "\\Drafts" | "\\Trash" | "\\Junk" | "\\Archive";
  readonly subscribed: boolean;
}

export interface SyncState {
  readonly mailboxPath: string;
  readonly uidValidity: number;
  readonly highestModSeq: bigint | null;
  readonly lastSyncedUid: number;
  readonly lastFetchAt: number;
}

export interface MessageHeader {
  readonly uid: number;
  readonly flags: readonly string[];
  readonly modSeq: bigint | null;
  readonly internalDate: Date;
  readonly size: number;
  readonly envelope: {
    readonly messageId: string | null;
    readonly subject: string | null;
    readonly date: Date | null;
    readonly from: readonly { name?: string; address: string }[];
    readonly to: readonly { name?: string; address: string }[];
    readonly inReplyTo: string | null;
  };
  readonly bodyStructure?: unknown;
}

export interface DeltaChange {
  readonly kind: "new" | "flags-changed" | "expunged";
  readonly uid: number;
  readonly modSeq?: bigint;
  readonly flags?: readonly string[];
}

export interface DeltaResult {
  readonly mailbox: string;
  readonly uidValidity: number;
  readonly newHighestModSeq: bigint | null;
  readonly changes: readonly DeltaChange[];
  readonly fullResyncRequired: boolean;
}

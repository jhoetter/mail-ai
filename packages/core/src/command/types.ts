// Command + Mutation types per prompt.md §The AI-Native Design.
// Every state change in mail-ai — human click, agent call, IMAP push —
// flows through CommandBus.dispatch and produces a Mutation. This file
// is the single shape contract; handlers live next to their domain
// (collaboration, imap-sync, etc.) and register against the bus.

export type CommandSource = "human" | "agent" | "system";

export type CommandTypeString = `${string}:${string}`;

export interface Command<
  TType extends CommandTypeString = CommandTypeString,
  TPayload = unknown,
> {
  readonly type: TType;
  readonly payload: TPayload;
  readonly source: CommandSource;
  readonly actorId: string;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly idempotencyKey?: string;
}

export type EntityKind = "thread" | "message" | "comment" | "tag" | "assignment" | "account";

export interface EntitySnapshot {
  readonly kind: EntityKind;
  readonly id: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export type EntityDiffOp =
  | { readonly op: "set"; readonly path: string; readonly value: unknown }
  | { readonly op: "unset"; readonly path: string }
  | { readonly op: "append"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string; readonly value: unknown };

export interface EntityDiff {
  readonly kind: EntityKind;
  readonly id: string;
  readonly ops: readonly EntityDiffOp[];
}

export type ImapSideEffect =
  | { readonly kind: "set-flag"; readonly accountId: string; readonly mailbox: string; readonly uid: number; readonly flag: string }
  | { readonly kind: "unset-flag"; readonly accountId: string; readonly mailbox: string; readonly uid: number; readonly flag: string }
  | { readonly kind: "move"; readonly accountId: string; readonly fromMailbox: string; readonly uid: number; readonly toMailbox: string }
  | { readonly kind: "expunge"; readonly accountId: string; readonly mailbox: string; readonly uid: number }
  | { readonly kind: "append"; readonly accountId: string; readonly mailbox: string; readonly bytes: number; readonly messageId: string }
  | { readonly kind: "smtp-submit"; readonly accountId: string; readonly messageId: string };

export type MutationStatus = "pending" | "applied" | "failed" | "rolled-back" | "rejected";

export interface Mutation {
  readonly id: string;
  readonly command: Command;
  readonly before: readonly EntitySnapshot[];
  readonly after: readonly EntitySnapshot[];
  readonly diffs: readonly EntityDiff[];
  readonly imapSideEffects: readonly ImapSideEffect[];
  readonly status: MutationStatus;
  readonly error?: { code: string; message: string };
  readonly approvedBy?: string;
  readonly approvedAt?: number;
  readonly rejectedReason?: string;
  readonly createdAt: number;
}

// BullMQ worker scaffolding for per-account sync jobs.
//
// Two job types:
//   - "sync-account"  → run MailboxSyncer over every LIST mailbox
//   - "apply-side-effects" → drive the Outboxer for a queued mutation
//
// We keep the queue / worker construction in `start*` factories so the
// rest of the package never imports BullMQ directly. Tests can run a
// MailboxSyncer without any Redis dependency.

import { Queue, Worker, QueueEvents, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { ImapConnectionPool } from "./pool.js";
import { MailboxSyncer } from "./syncer.js";
import { Outboxer, type ImapSideEffect } from "./outboxer.js";
import type { AccountCredentials, DeltaResult, MessageHeader, SyncState } from "./types.js";

export interface SyncJobData {
  readonly accountId: string;
  readonly creds: AccountCredentials;
  readonly mailboxPath: string;
  readonly previousState: SyncState | null;
}

export interface SideEffectsJobData {
  readonly accountId: string;
  readonly creds: AccountCredentials;
  readonly mutationId: string;
  readonly effects: readonly ImapSideEffect[];
}

export interface SyncJobResult {
  readonly mailboxPath: string;
  readonly delta?: DeltaResult;
  readonly initial?: { state: SyncState; headers: readonly MessageHeader[] };
}

const SYNC_QUEUE = "mailai-sync";
const OUTBOX_QUEUE = "mailai-outbox";

export function createSyncQueue(connection: Redis): Queue<SyncJobData> {
  return new Queue<SyncJobData>(SYNC_QUEUE, { connection });
}

export function createOutboxQueue(connection: Redis): Queue<SideEffectsJobData> {
  return new Queue<SideEffectsJobData>(OUTBOX_QUEUE, { connection });
}

export function startSyncWorker(opts: {
  connection: Redis;
  poolFor(accountId: string, creds: AccountCredentials): Promise<ImapConnectionPool>;
  onResult?: (job: Job<SyncJobData>, result: SyncJobResult) => Promise<void> | void;
}): Worker<SyncJobData, SyncJobResult> {
  const worker = new Worker<SyncJobData, SyncJobResult>(
    SYNC_QUEUE,
    async (job) => {
      const pool = await opts.poolFor(job.data.accountId, job.data.creds);
      const conn = await pool.acquire();
      try {
        const syncer = new MailboxSyncer(conn);
        if (!job.data.previousState) {
          const initial = await syncer.initialFetch(job.data.mailboxPath);
          const result: SyncJobResult = { mailboxPath: job.data.mailboxPath, initial };
          await opts.onResult?.(job, result);
          return result;
        }
        const delta = await syncer.deltaSync(job.data.previousState);
        const result: SyncJobResult = { mailboxPath: job.data.mailboxPath, delta };
        await opts.onResult?.(job, result);
        return result;
      } finally {
        pool.release(conn);
      }
    },
    { connection: opts.connection, concurrency: 4 },
  );
  return worker;
}

export interface OutboxJobResult {
  readonly mutationId: string;
  readonly results: ReturnType<Outboxer["run"]> extends Promise<infer R> ? R : never;
}

export function startOutboxWorker(opts: {
  connection: Redis;
  poolFor(accountId: string, creds: AccountCredentials): Promise<ImapConnectionPool>;
  onResult?: (job: Job<SideEffectsJobData>, result: OutboxJobResult) => Promise<void> | void;
}): Worker<SideEffectsJobData, OutboxJobResult> {
  return new Worker<SideEffectsJobData, OutboxJobResult>(
    OUTBOX_QUEUE,
    async (job) => {
      const pool = await opts.poolFor(job.data.accountId, job.data.creds);
      const conn = await pool.acquire();
      try {
        const outbox = new Outboxer(conn);
        const results = await outbox.run(job.data.effects);
        const result: OutboxJobResult = { mutationId: job.data.mutationId, results };
        await opts.onResult?.(job, result);
        return result;
      } finally {
        pool.release(conn);
      }
    },
    { connection: opts.connection, concurrency: 4 },
  );
}

export function watchQueueEvents(
  connection: Redis,
  queue: typeof SYNC_QUEUE | typeof OUTBOX_QUEUE,
) {
  return new QueueEvents(queue, { connection });
}

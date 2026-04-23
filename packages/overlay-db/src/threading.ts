// Threading persistence layer.
//
// On message ingest:
//   1. Resolve sibling messages by Message-ID intersection.
//   2. Run @mailai/mime#thread() over the local cluster.
//   3. Decide a single thread_id for the new message; merge older clusters
//      into the older thread when they collapse.
//
// We do NOT recompute threads for the entire mailbox per-ingest; we
// scope to the references touched by this message — see
// /spec/overlay/threading.md "Windowing for performance".

import { thread, type ThreadingInputMessage } from "@mailai/mime";
import type { Database } from "./client.js";
import { messages, threads } from "./schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export interface IngestMessage extends ThreadingInputMessage {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly internalDate: Date;
}

export interface ThreadAssignment {
  readonly messageId: string;
  readonly threadId: string;
  readonly mergedFrom: readonly string[];
}

export async function assignThread(db: Database, m: IngestMessage): Promise<ThreadAssignment> {
  const refIds = Array.from(new Set([m.messageId, ...m.references, ...m.inReplyTo]));
  // Find all messages already known whose Message-ID is in refIds OR
  // whose references mention m.messageId.
  const localRows = await db
    .select({
      id: messages.id,
      messageId: messages.messageId,
      threadId: messages.threadId,
      inReplyTo: messages.inReplyTo,
      referencesJson: messages.referencesJson,
      subject: messages.subject,
      internalDate: messages.internalDate,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, m.tenantId),
        sql`(message_id = ANY(${refIds}) OR references_json::text LIKE '%' || ${m.messageId} || '%')`,
      ),
    );

  const inputs: ThreadingInputMessage[] = [
    {
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      ...(m.subject ? { subject: m.subject } : {}),
      internalDate: m.internalDate,
    } as ThreadingInputMessage,
    ...localRows
      .filter((r) => r.messageId)
      .map((r) => {
        const refs = Array.isArray(r.referencesJson) ? (r.referencesJson as string[]) : [];
        return {
          messageId: r.messageId!,
          inReplyTo: r.inReplyTo ? [r.inReplyTo] : [],
          references: refs,
          ...(r.subject ? { subject: r.subject } : {}),
          internalDate: r.internalDate,
        } as ThreadingInputMessage;
      }),
  ];

  const forest = thread(inputs);
  // Find the root that contains m.messageId; collect all message IDs under it.
  function collect(root: ReturnType<typeof thread>[number]): string[] {
    const out: string[] = [];
    function walk(n: typeof root) {
      if (n.message?.messageId) out.push(n.message.messageId);
      for (const c of n.children) walk(c);
    }
    walk(root);
    return out;
  }
  let cluster: string[] = [];
  for (const root of forest) {
    const ids = collect(root);
    if (ids.includes(m.messageId)) {
      cluster = ids;
      break;
    }
  }

  // What thread_ids are already in use across the cluster?
  const existing = await db
    .select({ id: messages.id, threadId: messages.threadId, messageId: messages.messageId })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, m.tenantId),
        inArray(messages.messageId, cluster.length ? cluster : [m.messageId]),
      ),
    );
  const threadIds = Array.from(
    new Set(existing.map((r) => r.threadId).filter((x): x is string => !!x)),
  );

  // Decide canonical thread.
  let canonicalThreadId: string;
  const mergedFrom: string[] = [];
  if (threadIds.length === 0) {
    canonicalThreadId = `thr_${randomUUID()}`;
    await db.insert(threads).values({
      id: canonicalThreadId,
      tenantId: m.tenantId,
      accountId: m.accountId,
      rootMessageId: m.messageId,
      subject: m.subject ?? null,
      status: "open",
      snoozedUntil: null,
      assignedTo: null,
      lastMessageAt: m.internalDate,
    });
  } else if (threadIds.length === 1) {
    canonicalThreadId = threadIds[0]!;
    await db
      .update(threads)
      .set({ lastMessageAt: m.internalDate })
      .where(and(eq(threads.tenantId, m.tenantId), eq(threads.id, canonicalThreadId)));
  } else {
    // Pick the oldest thread (by id ordering as a deterministic stand-in
    // for created_at when ids are time-sortable UUIDv7 prefixes).
    const sorted = [...threadIds].sort();
    canonicalThreadId = sorted[0]!;
    mergedFrom.push(...sorted.slice(1));
    await db
      .update(messages)
      .set({ threadId: canonicalThreadId })
      .where(and(eq(messages.tenantId, m.tenantId), inArray(messages.threadId, mergedFrom)));
    await db
      .delete(threads)
      .where(and(eq(threads.tenantId, m.tenantId), inArray(threads.id, mergedFrom)));
    await db
      .update(threads)
      .set({ lastMessageAt: m.internalDate })
      .where(and(eq(threads.tenantId, m.tenantId), eq(threads.id, canonicalThreadId)));
  }

  return { messageId: m.id, threadId: canonicalThreadId, mergedFrom };
}

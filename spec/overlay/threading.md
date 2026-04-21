# overlay-db — threading

We use the JWZ algorithm (https://www.jwz.org/doc/threading.html) implemented in [`packages/mime/src/threading.ts`](../../packages/mime/src/threading.ts) and persist the result.

## Pipeline

```
ingest message m
  → dedup: SELECT id FROM messages WHERE tenant_id=? AND message_id=?
  → if exists in another mailbox → reuse same `messages.id`
  → run thread() over (m + every message that shares any References / In-Reply-To id with m)
    (windowed query: WHERE tenant_id AND message_id IN (m.message_id, m.refs..., siblings))
  → if a single thread results → assign m.thread_id; bump thread.last_message_at
  → if multiple threads collapsed (m linked them) → MERGE: pick the older thread,
     UPDATE messages SET thread_id = older.id WHERE thread_id IN newer.ids,
     DELETE the newer thread rows.
```

## Windowing for performance

A naïve "rebuild all threads on every ingest" is O(N) per message. We bound the
work by:

1. Looking up only messages whose `message_id` appears in `m.references ∪ {m.message_id}`.
2. UNION with messages whose `references` contain `m.message_id`.
3. UNION with messages already in `(m.thread_id_candidate)` if any.

The resulting set is typically O(thread depth), which is small.

## Subject-fallback (off by default)

JWZ §5 (subject-based stitching) is disabled because it produces false positives in shared inboxes (multiple unrelated tickets with the same subject "Re: invoice"). It can be enabled per-tenant by toggling `tenants.config.threading_subject_merge = true`.

## Determinism

Threading is content-addressed by `message_id`. Re-running it on the same input set produces the same `threads` row. Tested in `packages/overlay-db/test/threading.deterministic.test.ts` (Phase 2 build).

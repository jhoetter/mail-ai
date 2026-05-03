import type { CommandBus } from "@mailai/core";
import { DraftsRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface ScheduledDraftWorkerOpts {
  readonly pool: Pool;
  readonly bus: CommandBus;
  readonly tenants: () => Promise<readonly string[]>;
  readonly intervalMs?: number;
}

/**
 * Polls `drafts.scheduled_send_at` and dispatches `draft:send` when due.
 * Intended to run in-process alongside the API (single-replica dev/small prod).
 */
export function startScheduledDraftWorker(opts: ScheduledDraftWorkerOpts): () => void {
  const intervalMs = Math.max(10_000, opts.intervalMs ?? 30_000);
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void tick();
  return () => clearInterval(timer);

  async function tick(): Promise<void> {
    const tenantIds = await opts.tenants();
    const now = new Date();
    for (const tenantId of tenantIds) {
      let due: Awaited<ReturnType<DraftsRepository["listDueScheduled"]>> = [];
      try {
        due = await withTenant(opts.pool, tenantId, async (tx) => {
          const repo = new DraftsRepository(tx);
          return repo.listDueScheduled(now, 40);
        });
      } catch (err) {
        console.warn("[scheduled-drafts] list due failed", { tenantId, err: String(err) });
        continue;
      }
      for (const d of due) {
        try {
          await opts.bus.dispatch(
            {
              type: "draft:send",
              payload: { id: d.id },
              source: "human",
              actorId: d.userId,
              timestamp: Date.now(),
              sessionId: "scheduled-drafts",
            },
            { tenantId },
          );
        } catch (err) {
          console.warn("[scheduled-drafts] send failed", {
            tenantId,
            draftId: d.id,
            err: String(err),
          });
        }
      }
    }
  }
}

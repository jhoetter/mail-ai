// SLA timer evaluation. Per prompt.md, v1 only surfaces "overdue right
// now" — no historical reporting. Inputs are pure data so this layer
// stays trivially testable.

export interface SlaPolicy {
  readonly inboxId: string;
  readonly responseTargetMinutes: number;
}

export interface ThreadSnapshot {
  readonly threadId: string;
  readonly inboxId: string;
  readonly lastInboundAt: Date;
  readonly lastOutboundAt: Date | null;
  readonly status: "open" | "snoozed" | "resolved" | "archived";
}

export interface SlaState {
  readonly threadId: string;
  readonly overdue: boolean;
  readonly minutesElapsed: number;
}

export function evaluateSla(
  threads: readonly ThreadSnapshot[],
  policies: readonly SlaPolicy[],
  now: Date,
): SlaState[] {
  const policyByInbox = new Map(policies.map((p) => [p.inboxId, p]));
  const out: SlaState[] = [];
  for (const t of threads) {
    if (t.status !== "open") continue;
    if (t.lastOutboundAt && t.lastOutboundAt > t.lastInboundAt) continue;
    const policy = policyByInbox.get(t.inboxId);
    if (!policy) continue;
    const minutes = Math.floor((now.getTime() - t.lastInboundAt.getTime()) / 60_000);
    out.push({
      threadId: t.threadId,
      overdue: minutes > policy.responseTargetMinutes,
      minutesElapsed: minutes,
    });
  }
  return out;
}

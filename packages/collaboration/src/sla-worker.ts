// SLA worker. Periodically asks `evaluateSla` who is overdue and emits
// `sla:overdue` events. Also auto-reopens snoozed threads whose
// `snoozedUntil` has elapsed, by issuing a normal `thread:set-status`
// command — which keeps the audit log honest (snooze->open transitions
// look identical regardless of whether a human or the worker fired
// them, except for `actorId`).

import { evaluateSla, type SlaPolicy, type ThreadSnapshot, type SlaState } from "./sla.js";

export interface SlaEventSink {
  emit(event: { type: "sla:overdue"; threadId: string; minutesElapsed: number }): void;
}

export interface SlaCommandIssuer {
  issue(cmd: { type: "thread:set-status"; threadId: string; status: "open"; actorId: string }): Promise<void>;
}

export interface SlaWorkerDeps {
  readonly loadOpenThreads: () => Promise<readonly ThreadSnapshot[]>;
  readonly loadSnoozedThreads: () => Promise<readonly { threadId: string; snoozedUntil: Date }[]>;
  readonly loadPolicies: () => Promise<readonly SlaPolicy[]>;
  readonly events: SlaEventSink;
  readonly issuer: SlaCommandIssuer;
  readonly now?: () => Date;
}

export async function runSlaTick(deps: SlaWorkerDeps): Promise<{
  overdue: SlaState[];
  reopened: string[];
}> {
  const now = (deps.now ?? (() => new Date()))();
  const [threads, policies, snoozed] = await Promise.all([
    deps.loadOpenThreads(),
    deps.loadPolicies(),
    deps.loadSnoozedThreads(),
  ]);
  const states = evaluateSla(threads, policies, now);
  for (const s of states) {
    if (s.overdue) deps.events.emit({ type: "sla:overdue", threadId: s.threadId, minutesElapsed: s.minutesElapsed });
  }
  const reopened: string[] = [];
  for (const row of snoozed) {
    if (row.snoozedUntil <= now) {
      await deps.issuer.issue({
        type: "thread:set-status",
        threadId: row.threadId,
        status: "open",
        actorId: "system:sla-worker",
      });
      reopened.push(row.threadId);
    }
  }
  return { overdue: states.filter((s) => s.overdue), reopened };
}

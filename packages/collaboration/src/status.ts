// Status workflow state machine. Always overlay-only — never written to
// IMAP. Transitions are explicit; reaching a terminal state requires a
// user action (no automatic re-open without an inbound reply).

export type ThreadStatus = "open" | "snoozed" | "resolved" | "archived";

const TRANSITIONS: Readonly<Record<ThreadStatus, readonly ThreadStatus[]>> = {
  open: ["snoozed", "resolved", "archived"],
  snoozed: ["open", "resolved", "archived"],
  resolved: ["open", "archived"],
  archived: ["open"],
};

export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ThreadStatus, to: ThreadStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new Error(`invalid status transition: ${from} → ${to}`);
  }
}

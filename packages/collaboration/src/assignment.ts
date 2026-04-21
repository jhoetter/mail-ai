// Assignment rules. Single-assignee per thread; reassignment is a
// tracked event so audit_log + UI can show history. The "history" is
// derived from audit_log entries with command_type IN ('thread:assign',
// 'thread:unassign'); we don't persist a separate history table.

export interface AssignmentChange {
  readonly threadId: string;
  readonly previousAssigneeId: string | null;
  readonly newAssigneeId: string | null;
  readonly actorId: string;
  readonly at: Date;
}

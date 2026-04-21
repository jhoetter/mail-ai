// Role-based access control. Per prompt.md: admin, member, read-only.
// The capability table is the single source of truth.

export type Role = "admin" | "member" | "read-only";
export type Capability =
  | "thread.read"
  | "thread.write"
  | "thread.assign"
  | "thread.set-status"
  | "comment.add"
  | "comment.edit-own"
  | "comment.delete-any"
  | "account.connect"
  | "account.disconnect"
  | "settings.write";

const TABLE: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  admin: new Set([
    "thread.read",
    "thread.write",
    "thread.assign",
    "thread.set-status",
    "comment.add",
    "comment.edit-own",
    "comment.delete-any",
    "account.connect",
    "account.disconnect",
    "settings.write",
  ]),
  member: new Set([
    "thread.read",
    "thread.write",
    "thread.assign",
    "thread.set-status",
    "comment.add",
    "comment.edit-own",
  ]),
  "read-only": new Set(["thread.read"]),
};

export function can(role: Role, cap: Capability): boolean {
  return TABLE[role].has(cap);
}

export function assertCan(role: Role, cap: Capability): void {
  if (!can(role, cap)) {
    throw new Error(`role "${role}" lacks capability "${cap}"`);
  }
}

// Inbox-level RBAC. Tenant role gates "can the user touch the product
// at all"; inbox role gates "what can they do inside this inbox".
// Effective capability == intersection of (tenant role caps, inbox role
// caps). The two layers are deliberately separate so a tenant admin who
// is only a viewer on inbox A cannot mutate inbox A.

export type InboxRole = "inbox-admin" | "agent" | "viewer";

const INBOX_TABLE: Readonly<Record<InboxRole, ReadonlySet<Capability>>> = {
  "inbox-admin": new Set([
    "thread.read",
    "thread.write",
    "thread.assign",
    "thread.set-status",
    "comment.add",
    "comment.edit-own",
    "comment.delete-any",
  ]),
  agent: new Set([
    "thread.read",
    "thread.write",
    "thread.assign",
    "thread.set-status",
    "comment.add",
    "comment.edit-own",
  ]),
  viewer: new Set(["thread.read"]),
};

export function canInInbox(
  tenantRole: Role,
  inboxRole: InboxRole | null,
  cap: Capability,
): boolean {
  if (!can(tenantRole, cap)) return false;
  if (!inboxRole) return false;
  return INBOX_TABLE[inboxRole].has(cap);
}

export function assertCanInInbox(
  tenantRole: Role,
  inboxRole: InboxRole | null,
  cap: Capability,
): void {
  if (!canInInbox(tenantRole, inboxRole, cap)) {
    throw new Error(
      `tenant=${tenantRole} inbox=${inboxRole ?? "<none>"} lacks capability "${cap}"`,
    );
  }
}

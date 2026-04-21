// Per-command staging policy. Captures the table from prompt.md §The
// Human Review Flow:
//
//   - "auto"     → always applied immediately, even from agents
//   - "configurable" → default to "approve" but admins can override
//                       per-inbox / per-agent
//   - "approve"  → never auto-applied from agents; always staged
//
// Human-source commands always auto-apply regardless of policy.

import type { Command, CommandTypeString } from "./types.js";

export type StagingPolicy = "auto" | "configurable" | "approve";

const POLICIES: Readonly<Record<string, StagingPolicy>> = {
  // Always-auto
  "mail:mark-read": "auto",
  "mail:mark-unread": "auto",
  "thread:add-tag": "auto",
  "thread:remove-tag": "auto",
  "comment:add": "auto",

  // Always-approve from agents
  "mail:send": "approve",
  "mail:reply": "approve",
  "mail:forward": "approve",
  "mail:delete": "approve",
  "account:disconnect": "approve",

  // Configurable (default: approve from agents)
  "mail:archive": "configurable",
  "mail:move-to-folder": "configurable",
  "mail:flag": "configurable",
  "thread:assign": "configurable",
  "thread:unassign": "configurable",
  "thread:set-status": "configurable",
  "thread:snooze": "configurable",
  "comment:edit": "configurable",
  "comment:delete": "configurable",
  "account:connect": "configurable",
  "account:resync": "configurable",
};

export function policyFor(type: CommandTypeString): StagingPolicy {
  return POLICIES[type] ?? "approve";
}

export interface PolicyOverrides {
  readonly perAgent?: Readonly<Record<string, Partial<Record<CommandTypeString, StagingPolicy>>>>;
  readonly perInbox?: Readonly<Record<string, Partial<Record<CommandTypeString, StagingPolicy>>>>;
}

export function shouldStage(cmd: Command, overrides: PolicyOverrides = {}, inboxId?: string): boolean {
  if (cmd.source !== "agent") return false;
  let policy: StagingPolicy = policyFor(cmd.type);
  const agentOverride = overrides.perAgent?.[cmd.actorId]?.[cmd.type];
  if (agentOverride) policy = agentOverride;
  if (inboxId) {
    const inboxOverride = overrides.perInbox?.[inboxId]?.[cmd.type];
    if (inboxOverride) policy = inboxOverride;
  }
  switch (policy) {
    case "auto":
      return false;
    case "approve":
      return true;
    case "configurable":
      return true; // default: stage
  }
}

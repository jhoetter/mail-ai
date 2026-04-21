// Collaboration plugin: registers all collaboration-domain command
// handlers against the bus. Repositories are injected so this stays
// pure-domain and unit-testable without a real DB.
//
// Handler responsibilities:
//   * Read the current entity snapshot.
//   * Validate (RBAC, status transition, mentions).
//   * Compute the next snapshot.
//   * Return both for the bus to diff and audit.

import { randomUUID } from "node:crypto";
import {
  CommandBus,
  type CommandHandler,
  type EntitySnapshot,
  type MailaiPlugin,
} from "@mailai/core";
import {
  ThreadsRepository,
  CommentsRepository,
  type ThreadStatus,
} from "@mailai/overlay-db";
import { assertTransition } from "./status.js";
import { extractMentionHandles } from "./comments.js";

export interface CollaborationContext {
  readonly tenantId: string;
  readonly threads: ThreadsRepository;
  readonly comments?: CommentsRepository;
}

export class CollaborationPlugin implements MailaiPlugin {
  readonly name = "collaboration";
  readonly description = "Assignment, status, comments, tags, audit";

  constructor(private readonly ctx: CollaborationContext) {}

  register(bus: CommandBus): void {
    bus.register("thread:set-status", this.setStatus);
    bus.register("thread:assign", this.assign);
    bus.register("thread:unassign", this.unassign);
    bus.register("comment:add", this.addComment);
  }

  private setStatus: CommandHandler<"thread:set-status", { threadId: string; status: ThreadStatus }> = async (cmd) => {
    const cur = await this.ctx.threads.byId(this.ctx.tenantId, cmd.payload.threadId);
    if (!cur) throw new Error(`thread ${cmd.payload.threadId} not found`);
    assertTransition(cur.status, cmd.payload.status);
    await this.ctx.threads.setStatus(this.ctx.tenantId, cur.id, cmd.payload.status);
    return {
      before: [snap(cur, { status: cur.status })],
      after: [snap(cur, { status: cmd.payload.status })],
    };
  };

  private assign: CommandHandler<"thread:assign", { threadId: string; assigneeId: string }> = async (cmd) => {
    const cur = await this.ctx.threads.byId(this.ctx.tenantId, cmd.payload.threadId);
    if (!cur) throw new Error(`thread ${cmd.payload.threadId} not found`);
    await this.ctx.threads.assign(this.ctx.tenantId, cur.id, cmd.payload.assigneeId);
    return {
      before: [snap(cur, { assignedTo: cur.assignedTo })],
      after: [snap(cur, { assignedTo: cmd.payload.assigneeId })],
    };
  };

  private unassign: CommandHandler<"thread:unassign", { threadId: string }> = async (cmd) => {
    const cur = await this.ctx.threads.byId(this.ctx.tenantId, cmd.payload.threadId);
    if (!cur) throw new Error(`thread ${cmd.payload.threadId} not found`);
    await this.ctx.threads.assign(this.ctx.tenantId, cur.id, null);
    return {
      before: [snap(cur, { assignedTo: cur.assignedTo })],
      after: [snap(cur, { assignedTo: null })],
    };
  };

  private addComment: CommandHandler<"comment:add", { threadId: string; text: string; mentions?: string[] }> = async (cmd) => {
    const handles = extractMentionHandles(cmd.payload.text);
    const mentions = cmd.payload.mentions ?? handles;
    const id = randomUUID();
    if (this.ctx.comments) {
      await this.ctx.comments.insert({
        id,
        tenantId: this.ctx.tenantId,
        threadId: cmd.payload.threadId,
        authorId: cmd.actorId,
        body: cmd.payload.text,
        mentionsJson: mentions,
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
      });
    }
    return {
      before: [],
      after: [
        {
          kind: "comment",
          id,
          version: 1,
          data: {
            threadId: cmd.payload.threadId,
            text: cmd.payload.text,
            mentions,
            authorId: cmd.actorId,
          },
        },
      ],
    };
  };
}

function snap(
  thread: { id: string; assignedTo: string | null; status: string },
  patch: Record<string, unknown>,
): EntitySnapshot {
  return {
    kind: "thread",
    id: thread.id,
    version: 1,
    data: { id: thread.id, status: thread.status, assignedTo: thread.assignedTo, ...patch },
  };
}

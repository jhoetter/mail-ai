// CommandBus handlers for thread:add-tag and thread:remove-tag.
//
// Why a server-side handler instead of a direct repository call from
// the route: the bus is the only mutation path. Going through it
// gives us the audit log, idempotency caching, and a single chokepoint
// for future side effects (e.g. publishing tag-changed events to
// connected websocket clients).
//
// `threadId` in the payload is the OAuth-side oauth_messages.id (used
// as the URL-safe row identifier in the inbox). We resolve it to the
// stable provider_thread_id before storing, so retagging a different
// row in the same conversation lands on the same set.
//
// Tag-by-name semantics: ensureByName creates the tag definition on
// demand. This matches the Notion-Mail UX where the user types a
// new tag and hits enter.

import type { CommandHandler, EntitySnapshot, HandlerResult } from "@mailai/core";
import { MailaiError } from "@mailai/core";
import {
  OauthMessagesRepository,
  OauthThreadTagsRepository,
  TagsRepository,
  withTenant,
  type Pool,
} from "@mailai/overlay-db";

export interface ThreadTagDeps {
  readonly pool: Pool;
  readonly tenantId: string;
}

interface AddTagPayload {
  threadId: string;
  tag: string;
}

interface RemoveTagPayload {
  threadId: string;
  tag: string;
}

export function buildThreadAddTagHandler(
  deps: ThreadTagDeps,
): CommandHandler<"thread:add-tag", AddTagPayload> {
  return async (cmd) => {
    const { threadId, tag } = cmd.payload;
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const messages = new OauthMessagesRepository(tx);
      const tags = new TagsRepository(tx);
      const threadTags = new OauthThreadTagsRepository(tx);

      const root = await messages.byId(deps.tenantId, threadId);
      if (!root) {
        throw new MailaiError("not_found", `thread ${threadId} not found`);
      }
      const tagRow = await tags.ensureByName(deps.tenantId, tag);
      const before = await threadTags.listForThread(deps.tenantId, root.providerThreadId);
      await threadTags.add(deps.tenantId, root.providerThreadId, tagRow.id, cmd.actorId);
      const after = await threadTags.listForThread(deps.tenantId, root.providerThreadId);
      return snapshot(root.providerThreadId, before, after);
    });
  };
}

export function buildThreadRemoveTagHandler(
  deps: ThreadTagDeps,
): CommandHandler<"thread:remove-tag", RemoveTagPayload> {
  return async (cmd) => {
    const { threadId, tag } = cmd.payload;
    return withTenant(deps.pool, deps.tenantId, async (tx) => {
      const messages = new OauthMessagesRepository(tx);
      const tags = new TagsRepository(tx);
      const threadTags = new OauthThreadTagsRepository(tx);

      const root = await messages.byId(deps.tenantId, threadId);
      if (!root) {
        throw new MailaiError("not_found", `thread ${threadId} not found`);
      }
      const tagRow = await tags.byName(deps.tenantId, tag);
      if (!tagRow) {
        // Removing a non-existent tag is a no-op rather than an error
        // — the user probably hit "remove" twice and the second click
        // shouldn't rage at them.
        return emptySnapshot(root.providerThreadId);
      }
      const before = await threadTags.listForThread(deps.tenantId, root.providerThreadId);
      await threadTags.remove(deps.tenantId, root.providerThreadId, tagRow.id);
      const after = await threadTags.listForThread(deps.tenantId, root.providerThreadId);
      return snapshot(root.providerThreadId, before, after);
    });
  };
}

function snapshot(
  providerThreadId: string,
  before: ReadonlyArray<{ id: string; name: string }>,
  after: ReadonlyArray<{ id: string; name: string }>,
): HandlerResult {
  const beforeSnap: EntitySnapshot = {
    kind: "thread-tag",
    id: providerThreadId,
    version: before.length,
    data: { tags: before.map((t) => ({ id: t.id, name: t.name })) },
  };
  const afterSnap: EntitySnapshot = {
    kind: "thread-tag",
    id: providerThreadId,
    version: after.length,
    data: { tags: after.map((t) => ({ id: t.id, name: t.name })) },
  };
  return { before: [beforeSnap], after: [afterSnap], imapSideEffects: [] };
}

function emptySnapshot(providerThreadId: string): HandlerResult {
  return {
    before: [{ kind: "thread-tag", id: providerThreadId, version: 0, data: { tags: [] } }],
    after: [{ kind: "thread-tag", id: providerThreadId, version: 0, data: { tags: [] } }],
    imapSideEffects: [],
  };
}

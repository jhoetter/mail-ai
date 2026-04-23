// Shared-inbox CRUD + member/mailbox management.
//
// Roles:
//   - inbox-admin: can edit + delete + manage members
//   - agent:      can act on threads in this inbox
//   - viewer:     read-only
//
// We don't enforce role-based authorization at the HTTP layer yet
// because the dev identity returns a single admin user. The server-
// side role column is captured today so the future authz wiring is a
// no-op for already-stored data.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { InboxesRepository, withTenant, type Pool } from "@mailai/overlay-db";

export interface InboxRoutesDeps {
  readonly pool: Pool;
  readonly identity: (req: { headers: Record<string, unknown> }) => Promise<{
    userId: string;
    tenantId: string;
  }>;
}

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  members: z
    .array(
      z.object({ userId: z.string().min(1), role: z.enum(["inbox-admin", "agent", "viewer"]) }),
    )
    .optional(),
  mailboxes: z
    .array(z.object({ accountId: z.string().min(1), mailboxPath: z.string().min(1) }))
    .optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  config: z.record(z.unknown()).optional(),
});

const AddMemberBody = z.object({
  userId: z.string().min(1),
  role: z.enum(["inbox-admin", "agent", "viewer"]),
});

const AddMailboxBody = z.object({
  accountId: z.string().min(1),
  mailboxPath: z.string().min(1),
});

export function registerInboxRoutes(app: FastifyInstance, deps: InboxRoutesDeps): void {
  app.get("/api/inboxes", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const rows = await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new InboxesRepository(tx);
      return repo.list(ident.tenantId);
    });
    return { inboxes: rows };
  });

  app.post("/api/inboxes", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const id = `inb_${crypto.randomUUID()}`;
    const created = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new InboxesRepository(tx);
      await repo.insert({
        id,
        tenantId: ident.tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        config: {},
      });
      // Caller is implicit admin so they can manage what they just
      // created. Override via explicit members list if needed.
      const members = parsed.data.members ?? [
        { userId: ident.userId, role: "inbox-admin" as const },
      ];
      for (const m of members) {
        await repo.addMember({
          inboxId: id,
          userId: m.userId,
          role: m.role,
          tenantId: ident.tenantId,
        });
      }
      for (const mb of parsed.data.mailboxes ?? []) {
        await repo.addMailbox({
          inboxId: id,
          accountId: mb.accountId,
          mailboxPath: mb.mailboxPath,
          tenantId: ident.tenantId,
        });
      }
      const row = await repo.byId(ident.tenantId, id);
      return row;
    });
    return reply.code(201).send(created);
  });

  app.get("/api/inboxes/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const result = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new InboxesRepository(tx);
      const row = await repo.byId(ident.tenantId, id);
      if (!row) return null;
      const [members, mailboxes] = await Promise.all([
        repo.listMembers(ident.tenantId, id),
        repo.listMailboxes(ident.tenantId, id),
      ]);
      return { ...row, members, mailboxes };
    });
    if (!result) return reply.code(404).send({ error: "not_found" });
    return result;
  });

  app.patch("/api/inboxes/:id", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    const updated = await withTenant(deps.pool, ident.tenantId, async (tx) => {
      const repo = new InboxesRepository(tx);
      const exists = await repo.byId(ident.tenantId, id);
      if (!exists) return null;
      await repo.update(ident.tenantId, id, parsed.data);
      return repo.byId(ident.tenantId, id);
    });
    if (!updated) return reply.code(404).send({ error: "not_found" });
    return updated;
  });

  app.delete("/api/inboxes/:id", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new InboxesRepository(tx);
      return repo.delete(ident.tenantId, id);
    });
    return { ok: true, id };
  });

  app.post("/api/inboxes/:id/members", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const parsed = AddMemberBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new InboxesRepository(tx);
      return repo.addMember({
        inboxId: id,
        userId: parsed.data.userId,
        role: parsed.data.role,
        tenantId: ident.tenantId,
      });
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete("/api/inboxes/:id/members/:userId", async (req) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id, userId } = req.params as { id: string; userId: string };
    await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new InboxesRepository(tx);
      return repo.removeMember(ident.tenantId, id, userId);
    });
    return { ok: true };
  });

  app.post("/api/inboxes/:id/mailboxes", async (req, reply) => {
    const ident = await deps.identity({ headers: req.headers as Record<string, unknown> });
    const { id } = req.params as { id: string };
    const parsed = AddMailboxBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", details: parsed.error.format() });
    }
    await withTenant(deps.pool, ident.tenantId, (tx) => {
      const repo = new InboxesRepository(tx);
      return repo.addMailbox({
        inboxId: id,
        accountId: parsed.data.accountId,
        mailboxPath: parsed.data.mailboxPath,
        tenantId: ident.tenantId,
      });
    });
    return reply.code(201).send({ ok: true });
  });
}

import type { Database } from "../client.js";
import { auditLog } from "../schema.js";
import type { Mutation } from "@mailai/core";

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async append(tenantId: string, mutation: Mutation): Promise<void> {
    await this.db.insert(auditLog).values({
      tenantId,
      mutationId: mutation.id,
      commandType: mutation.command.type,
      actorId: mutation.command.actorId,
      source: mutation.command.source,
      payloadJson: mutation.command.payload as object,
      diffJson: mutation.diffs as unknown as object,
      status: mutation.status,
    });
  }
}

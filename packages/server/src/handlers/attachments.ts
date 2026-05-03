// CommandBus handlers for the composer's attachment lifecycle.
//
// Three commands mirror collaboration-ai's "init → PUT → finalise"
// pattern. The browser owns the byte transfer; the server only sees
// metadata + a presigned URL. Bytes never travel through the API.
//
//   1. attachment:upload-init      → mints the fileId and presigned PUT
//   2. (browser PUTs to S3)
//   3. attachment:upload-finalise  → records the row in draft_attachments
//   4. attachment:remove           → deletes the row + best-effort S3 cleanup
//
// On send (`mail:send` / `mail:reply`) the rows are translated into
// real `oauth_attachments` rows and the staging bytes are copied into
// the message namespace.

import type {
  Command,
  CommandHandler,
  HandlerContext,
  HandlerResult,
} from "@mailai/core";
import { MailaiError, randomId } from "@mailai/core";
import {
  DraftAttachmentsRepository,
  attachmentKeys,
  withTenant,
  type ObjectStore,
  type Pool,
} from "@mailai/overlay-db";

export interface AttachmentDeps {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly objectStore: ObjectStore;
}

interface UploadInitPayload {
  filename: string;
  mime: string;
  sizeBytes?: number;
  draftId?: string;
}

interface UploadFinalisePayload {
  fileId: string;
  objectKey: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  draftId?: string;
}

interface RemovePayload {
  fileId: string;
}

export function buildAttachmentUploadInitHandler(
  base: AttachmentDeps,
): CommandHandler<"attachment:upload-init", UploadInitPayload> {
  return async (
    cmd: Command<"attachment:upload-init", UploadInitPayload>,
    hx: HandlerContext,
  ): Promise<HandlerResult> => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const payload = cmd.payload;
    const fileId = `file_${randomId()}`;
    // The "draft" prefix is intentional: we know nothing about a real
    // message yet. On send, mail-send.ts copies the bytes into
    // accounts/<id>/messages/<provider-id>/att/<file-id>.
    const draftBucket = payload.draftId ?? `unbound-${cmd.actorId}`;
    const objectKey = attachmentKeys.draft(draftBucket, fileId);
    const presigned = await deps.objectStore.presignPut(objectKey, {
      contentType: payload.mime,
      expiresInSeconds: 600,
    });
    return {
      before: [{ kind: "attachment", id: fileId, version: 0, data: {} }],
      after: [
        {
          kind: "attachment",
          id: fileId,
          version: 1,
          data: {
            fileId,
            objectKey,
            putUrl: presigned.url,
            headers: presigned.headers,
            expiresAt: presigned.expiresAt,
            filename: payload.filename,
            mime: payload.mime,
            sizeBytes: payload.sizeBytes ?? 0,
          },
        },
      ],
      imapSideEffects: [],
    };
  };
}

export function buildAttachmentUploadFinaliseHandler(
  base: AttachmentDeps,
): CommandHandler<"attachment:upload-finalise", UploadFinalisePayload> {
  return async (
    cmd: Command<"attachment:upload-finalise", UploadFinalisePayload>,
    hx: HandlerContext,
  ): Promise<HandlerResult> => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const payload = cmd.payload;
    // Refuse to record metadata for an object that didn't actually
    // land in S3 — the browser may have aborted the PUT.
    if (!(await deps.objectStore.exists(payload.objectKey))) {
      throw new MailaiError("validation_error", `object ${payload.objectKey} not found in S3`);
    }
    const row = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftAttachmentsRepository(tx);
      return repo.insert({
        id: payload.fileId,
        tenantId: deps.tenantId,
        userId: cmd.actorId,
        draftId: payload.draftId ?? null,
        objectKey: payload.objectKey,
        filename: payload.filename,
        mime: payload.mime,
        sizeBytes: payload.sizeBytes,
      });
    });
    return {
      before: [{ kind: "attachment", id: payload.fileId, version: 0, data: {} }],
      after: [
        {
          kind: "attachment",
          id: payload.fileId,
          version: 1,
          data: {
            fileId: row.id,
            filename: row.filename,
            mime: row.mime,
            sizeBytes: row.sizeBytes,
            draftId: row.draftId,
          },
        },
      ],
      imapSideEffects: [],
    };
  };
}

export function buildAttachmentRemoveHandler(
  base: AttachmentDeps,
): CommandHandler<"attachment:remove", RemovePayload> {
  return async (cmd: { payload: RemovePayload }, hx: HandlerContext): Promise<HandlerResult> => {
    const deps = { ...base, tenantId: hx.tenantId ?? base.tenantId };
    const payload = cmd.payload;
    const row = await withTenant(deps.pool, deps.tenantId, async (tx) => {
      const repo = new DraftAttachmentsRepository(tx);
      const found = await repo.byId(deps.tenantId, payload.fileId);
      if (!found) return null;
      await repo.delete(deps.tenantId, payload.fileId);
      return found;
    });
    if (row) {
      // Best-effort byte cleanup. If this fails the janitor can
      // sweep orphans later.
      try {
        await deps.objectStore.delete(row.objectKey);
      } catch (err) {
        console.warn("[attachment:remove] S3 delete failed", {
          objectKey: row.objectKey,
          err: String(err),
        });
      }
    }
    return {
      before: [
        {
          kind: "attachment",
          id: payload.fileId,
          version: 1,
          data: row ? { filename: row.filename } : {},
        },
      ],
      after: [{ kind: "attachment", id: payload.fileId, version: 2, data: { removed: true } }],
      imapSideEffects: [],
    };
  };
}

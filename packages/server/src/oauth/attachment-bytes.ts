// Shared lazy-fetch for oauth_attachments bytes (S3 cache + provider).

import {
  OauthAccountsRepository,
  OauthAttachmentsRepository,
  withTenant,
  type ObjectStore,
  type OauthAttachmentRow,
  type Pool,
} from "@mailai/overlay-db";
import { getValidAccessToken, type ProviderCredentials } from "@mailai/oauth-tokens";
import type { MailProviderRegistry } from "@mailai/providers";

export interface OauthAttachmentBytesDeps {
  readonly pool: Pool;
  readonly credentials: ProviderCredentials;
  readonly providers: MailProviderRegistry;
  readonly objectStore: ObjectStore;
}

export async function readOauthAttachmentBytes(
  deps: OauthAttachmentBytesDeps,
  tenantId: string,
  row: OauthAttachmentRow,
): Promise<Buffer> {
  if (await deps.objectStore.exists(row.objectKey)) {
    return deps.objectStore.getBytes(row.objectKey);
  }
  return withTenant(deps.pool, tenantId, async (tx) => {
    const accounts = new OauthAccountsRepository(tx);
    const attRepo = new OauthAttachmentsRepository(tx);
    const account = await accounts.byId(tenantId, row.oauthAccountId);
    if (!account) throw new Error(`account ${row.oauthAccountId} missing for attachment ${row.id}`);
    const accessToken = await getValidAccessToken(account, {
      tenantId,
      accounts,
      credentials: deps.credentials,
    });
    if (!row.providerAttachmentId) {
      throw new Error(`attachment ${row.id} has no providerAttachmentId`);
    }
    const bytes = await deps.providers.for(account.provider).fetchAttachmentBytes({
      accessToken,
      providerMessageId: row.providerMessageId,
      attachment: {
        providerAttachmentId: row.providerAttachmentId,
        filename: row.filename ?? "attachment",
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        contentId: row.contentId ?? null,
        isInline: row.isInline,
      },
    });
    await deps.objectStore.put(row.objectKey, bytes, row.mime);
    await attRepo.markCached(tenantId, row.id);
    return bytes;
  });
}

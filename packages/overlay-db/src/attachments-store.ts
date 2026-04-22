// Attachment object-store interface. The S3 client lives behind this
// interface so unit tests can swap in an in-memory store. Dev wiring
// uses MinIO (see infra/docker/compose.dev.yml).

import { Readable } from "node:stream";

export interface ObjectStore {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  // Returns the bytes as a Buffer for callers that want to splice the
  // payload into a MIME envelope without piping streams.
  getBytes(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  // Mint short-lived signed URLs so the browser can upload / download
  // bytes without round-tripping through the API. Expiration is in
  // seconds (S3 cap is 7 days, but we keep ours <= 1h).
  presignPut(key: string, opts: {
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }>;
  presignGet(key: string, opts?: {
    expiresInSeconds?: number;
    responseContentDisposition?: string;
    responseContentType?: string;
  }): Promise<{ url: string; expiresAt: number }>;
}

// Object-key namespacing. Two namespaces:
//   - "draft uploads" — the user picked a file in the composer but
//     hasn't sent yet; these are scoped per-draft so we can delete the
//     whole tree when the draft is discarded.
//   - "message attachments" — landed in oauth_messages; scoped per
//     account+message so we can lazy-fetch and cache provider blobs.
//
// All keys live under the bucket root with a single shape so the IAM /
// bucket policies (when production gets one) can target prefixes
// without parsing.
export interface AttachmentKeys {
  readonly draft: (draftId: string, fileId: string) => string;
  readonly accountMessageAtt: (
    accountId: string,
    providerMessageId: string,
    fileId: string,
  ) => string;
  readonly accountMessageRaw: (accountId: string, providerMessageId: string) => string;
}

export const attachmentKeys: AttachmentKeys = {
  draft: (draftId, fileId) => `drafts/${draftId}/att/${fileId}`,
  accountMessageAtt: (accountId, providerMessageId, fileId) =>
    `accounts/${accountId}/messages/${providerMessageId}/att/${fileId}`,
  accountMessageRaw: (accountId, providerMessageId) =>
    `accounts/${accountId}/messages/${providerMessageId}/raw.eml`,
};

// Legacy helper used by the IMAP-side messages table. Kept as-is so
// existing callers keep compiling.
export function objectKeys(tenantId: string, messageId: string) {
  const base = `t/${tenantId}/m/${messageId}`;
  return {
    raw: `${base}/raw.eml`,
    text: `${base}/text.txt`,
    html: `${base}/html.html`,
    attachment: (attachmentId: string) => `${base}/att/${attachmentId}`,
  };
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly map = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer | Readable, contentType?: string): Promise<void> {
    const ct = contentType ?? "application/octet-stream";
    if (Buffer.isBuffer(body)) {
      this.map.set(key, { body, contentType: ct });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
    this.map.set(key, { body: Buffer.concat(chunks), contentType: ct });
  }
  async get(key: string): Promise<Readable> {
    const v = this.map.get(key);
    if (!v) throw new Error(`object not found: ${key}`);
    return Readable.from(v.body);
  }
  async getBytes(key: string): Promise<Buffer> {
    const v = this.map.get(key);
    if (!v) throw new Error(`object not found: ${key}`);
    return v.body;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.map.has(key);
  }
  async presignPut(): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }> {
    throw new Error("InMemoryObjectStore does not support presigned URLs; use S3ObjectStore");
  }
  async presignGet(): Promise<{ url: string; expiresAt: number }> {
    throw new Error("InMemoryObjectStore does not support presigned URLs; use S3ObjectStore");
  }
}

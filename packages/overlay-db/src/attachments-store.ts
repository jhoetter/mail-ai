// Attachment object-store interface. The S3 client lives behind this
// interface so unit tests can swap in an in-memory store. Dev wiring
// uses MinIO (see infra/docker/compose.dev.yml).

import { Readable } from "node:stream";

export interface ObjectStore {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly map = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer | Readable): Promise<void> {
    if (Buffer.isBuffer(body)) {
      this.map.set(key, { body, contentType: "application/octet-stream" });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
    this.map.set(key, { body: Buffer.concat(chunks), contentType: "application/octet-stream" });
  }
  async get(key: string): Promise<Readable> {
    const v = this.map.get(key);
    if (!v) throw new Error(`object not found: ${key}`);
    return Readable.from(v.body);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.map.has(key);
  }
}

export function objectKeys(tenantId: string, messageId: string) {
  const base = `t/${tenantId}/m/${messageId}`;
  return {
    raw: `${base}/raw.eml`,
    text: `${base}/text.txt`,
    html: `${base}/html.html`,
    attachment: (attachmentId: string) => `${base}/att/${attachmentId}`,
  };
}

// S3-compatible ObjectStore. Talks to AWS S3 in production and to
// MinIO in dev (set S3_FORCE_PATH_STYLE=true so the bucket name lives
// in the URL path, which MinIO requires).
//
// We mirror the pattern used by ~/repos/collaboration-ai (boto3 + S3
// presigned PUT/GET) so the future hof-os integration is a one-line
// swap of the endpoint/credentials. Bytes never travel through the
// API: the browser PUTs directly to S3 with a presigned URL, and the
// API only mints + records metadata.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { ObjectStore } from "./attachments-store.js";

export interface S3ObjectStoreOptions {
  readonly endpoint?: string | undefined;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle?: boolean | undefined;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ObjectStoreOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  // Idempotent bucket bootstrap. headBucket → noop if it already
  // exists; createBucket otherwise. We swallow "already exists" races
  // so two server processes coming up simultaneously don't crash.
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status !== 404 && status !== 301 && status !== undefined) {
        // 403 (no permission) — swallow; presigned operations may
        // still work if the bucket exists and we just can't HEAD it.
        if (status === 403) return;
        throw err;
      }
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") return;
      throw err;
    }
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`object not found: ${key}`);
    return out.Body as Readable;
  }

  async getBytes(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`object not found: ${key}`);
    return await streamToBuffer(out.Body as Readable);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) return false;
      const code = (err as { name?: string }).name;
      if (code === "NotFound" || code === "NoSuchKey") return false;
      throw err;
    }
  }

  async presignPut(
    key: string,
    opts: { contentType: string; expiresInSeconds?: number },
  ): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }> {
    const expiresIn = Math.max(60, Math.min(opts.expiresInSeconds ?? 300, 3600));
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
      }),
      { expiresIn },
    );
    return {
      url,
      headers: { "Content-Type": opts.contentType },
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  async presignGet(
    key: string,
    opts?: {
      expiresInSeconds?: number;
      responseContentDisposition?: string;
      responseContentType?: string;
    },
  ): Promise<{ url: string; expiresAt: number }> {
    const expiresIn = Math.max(60, Math.min(opts?.expiresInSeconds ?? 300, 3600));
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(opts?.responseContentDisposition
        ? { ResponseContentDisposition: opts.responseContentDisposition }
        : {}),
      ...(opts?.responseContentType
        ? { ResponseContentType: opts.responseContentType }
        : {}),
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn });
    return { url, expiresAt: Date.now() + expiresIn * 1000 };
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Wrap an :class:`ObjectStore` so every key is transparently prefixed
 * with ``prefix/`` before hitting the backing store.
 *
 * The hof-os deployer threads ``S3_KEY_PREFIX=tenants/<t>/mail`` into
 * the mailai sidecar's container env so all attachments + raw EML
 * cache live under the cell's tenant root and the data-app's
 * ``ensure_key_under_tenant_prefix`` (functions/s3_tenant_keys.py) can
 * reopen them in ``/edit-asset?key=…`` without per-product carve-outs.
 *
 * Empty prefix returns ``store`` unchanged so standalone ``pnpm dev``
 * keeps writing under the bucket root the way it always has.
 */
export function withKeyPrefix(store: ObjectStore, prefix: string | undefined | null): ObjectStore {
  const cleaned = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (!cleaned) return store;
  const wrap = (k: string) => `${cleaned}/${k.replace(/^\/+/, "")}`;
  return {
    put: (k, body, ct) => store.put(wrap(k), body, ct),
    get: (k) => store.get(wrap(k)),
    getBytes: (k) => store.getBytes(wrap(k)),
    delete: (k) => store.delete(wrap(k)),
    exists: (k) => store.exists(wrap(k)),
    presignPut: (k, opts) => store.presignPut(wrap(k), opts),
    presignGet: (k, opts) => store.presignGet(wrap(k), opts),
  };
}

// Read S3 settings from process.env. Returns null when not all required
// values are present so callers can fall back to InMemoryObjectStore in
// minimal dev/test environments.
export function loadS3OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStoreOptions | null {
  const region = env["S3_REGION"];
  const bucket = env["S3_BUCKET"];
  const accessKeyId = env["S3_ACCESS_KEY"];
  const secretAccessKey = env["S3_SECRET_KEY"];
  if (!region || !bucket || !accessKeyId || !secretAccessKey) return null;
  const endpoint = env["S3_ENDPOINT"];
  const force = env["S3_FORCE_PATH_STYLE"];
  return {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(endpoint ? { endpoint } : {}),
    ...(force ? { forcePathStyle: force === "true" || force === "1" } : {}),
  };
}

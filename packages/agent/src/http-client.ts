// HTTP transport for the agent SDK. The CLI process uses this; the
// web server uses the in-process MailAgent directly. The two paths
// MUST produce the same Mutation rows; this client only marshals
// JSON over the wire.

import { MailaiError, type CommandTypeString, type Mutation } from "@mailai/core";
import { CommandPayloadSchema } from "./schemas.js";

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export interface HttpApplyInput {
  readonly type: CommandTypeString;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
  readonly inboxId?: string;
}

export class HttpAgentClient {
  constructor(private readonly opts: HttpClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  private url(path: string): string {
    return new URL(path, this.opts.baseUrl).toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.token}`,
      ...extra,
    };
  }

  async applyCommand(input: HttpApplyInput): Promise<Mutation> {
    const v = CommandPayloadSchema.safeParse({ type: input.type, payload: input.payload });
    if (!v.success) throw new MailaiError("validation_error", v.error.message);
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    if (input.inboxId) headers["x-inbox-id"] = input.inboxId;
    const res = await this.fetchImpl(this.url("/api/commands"), {
      method: "POST",
      headers: this.headers(headers),
      body: JSON.stringify({ type: input.type, payload: input.payload }),
    });
    if (!res.ok) await throwHttp(res);
    const body = (await res.json()) as { results: Mutation[] };
    const m = body.results?.[0];
    if (!m) throw new MailaiError("internal_error", "empty mutation result from server");
    return m;
  }

  async listPending(filter?: { actorId?: string; type?: CommandTypeString }): Promise<Mutation[]> {
    const url = new URL(this.url("/api/mutations/pending"));
    if (filter?.actorId) url.searchParams.set("actorId", filter.actorId);
    if (filter?.type) url.searchParams.set("type", filter.type);
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as Mutation[];
  }

  async approve(id: string): Promise<Mutation> {
    const res = await this.fetchImpl(this.url(`/api/mutations/${id}/approve`), {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as Mutation;
  }

  async reject(id: string, reason?: string): Promise<Mutation> {
    const res = await this.fetchImpl(this.url(`/api/mutations/${id}/reject`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as Mutation;
  }

  async whoami(): Promise<{ userId: string; tenantId: string; displayName: string }> {
    const res = await this.fetchImpl(this.url("/api/whoami"), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as { userId: string; tenantId: string; displayName: string };
  }
}

async function throwHttp(res: Response): Promise<never> {
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => undefined);
  }
  const code =
    res.status === 401 || res.status === 403
      ? "auth_error"
      : res.status === 409
        ? "conflict_error"
        : res.status >= 500
          ? "internal_error"
          : "validation_error";
  const msg =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : `HTTP ${res.status}`;
  throw new MailaiError(code, msg);
}

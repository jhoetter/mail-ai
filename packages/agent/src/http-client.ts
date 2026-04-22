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
  // Marks the dispatch as agent-source. The bus no longer treats this
  // any differently from a human-source command (staging is gone), but
  // we still record it on the audit trail so operators can later filter
  // commands by who actually initiated them.
  readonly source?: "human" | "agent" | "system";
}

// Read-shape types. Kept intentionally close to what the server emits
// today so callers can treat them as plain JSON.
export interface AccountSummary {
  readonly id: string;
  readonly provider: string;
  readonly email: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly lastSyncedAt: string | null;
  readonly lastSyncError: string | null;
}

export interface ThreadSummary {
  readonly id: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly provider: string;
  readonly subject: string;
  readonly from: string;
  readonly fromEmail: string | null;
  readonly snippet: string;
  readonly unread: boolean;
  readonly labels: readonly string[];
  readonly date: string;
}

export interface ThreadDetail {
  readonly id: string;
  readonly subject: string;
  readonly providerThreadId: string;
  readonly provider: string;
  readonly unreadCount: number;
  readonly messages: readonly ThreadMessage[];
}

export interface ThreadMessage {
  readonly id: string;
  readonly providerMessageId: string;
  readonly from: string;
  readonly fromEmail: string | null;
  readonly to: string | null;
  readonly date: string;
  readonly snippet: string;
  readonly unread: boolean;
}

export interface SearchHit {
  readonly threadId: string;
  readonly subject: string;
  readonly snippet: string;
  readonly rank: number;
}

export interface SyncResult {
  readonly fetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly durationMs: number;
}

export type InboxRole = "inbox-admin" | "agent" | "viewer";

export interface InboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly config: Record<string, unknown>;
}

export interface InboxMember {
  readonly inboxId: string;
  readonly userId: string;
  readonly role: InboxRole;
}

export interface InboxMailbox {
  readonly inboxId: string;
  readonly accountId: string;
  readonly mailboxPath: string;
}

export interface InboxDetail extends InboxRow {
  readonly members: readonly InboxMember[];
  readonly mailboxes: readonly InboxMailbox[];
}

export interface AuditEntry {
  readonly seq: string;
  readonly mutationId: string;
  readonly commandType: string;
  readonly actorId: string;
  readonly source: string;
  readonly status: string;
  readonly payload: unknown;
  readonly diff: unknown;
  readonly createdAt: string;
}

export interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly nextCursor: string | null;
}

export interface AuditQuery {
  actor?: string;
  type?: string;
  threadId?: string;
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateInboxInput {
  readonly name: string;
  readonly description?: string | null;
  readonly members?: readonly { userId: string; role: InboxRole }[];
  readonly mailboxes?: readonly { accountId: string; mailboxPath: string }[];
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

  // -------------------------------------------------------------- write

  async applyCommand(input: HttpApplyInput): Promise<Mutation> {
    const v = CommandPayloadSchema.safeParse({ type: input.type, payload: input.payload });
    if (!v.success) throw new MailaiError("validation_error", v.error.message);
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    if (input.inboxId) headers["x-inbox-id"] = input.inboxId;
    if (input.propose) headers["x-mailai-source"] = "agent";
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

  // --------------------------------------------------------------- read

  async listAccounts(): Promise<AccountSummary[]> {
    const res = await this.fetchImpl(this.url("/api/accounts"), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    const body = (await res.json()) as { accounts: AccountSummary[] };
    return body.accounts;
  }

  async resyncAccount(id: string): Promise<SyncResult> {
    const res = await this.fetchImpl(this.url(`/api/accounts/${id}/sync`), {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as SyncResult;
  }

  async deleteAccount(id: string): Promise<{ ok: true }> {
    const res = await this.fetchImpl(this.url(`/api/accounts/${id}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as { ok: true };
  }

  async listThreads(opts: { limit?: number } = {}): Promise<ThreadSummary[]> {
    const url = new URL(this.url("/api/threads"));
    if (opts.limit) url.searchParams.set("limit", String(opts.limit));
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    const body = (await res.json()) as { threads: ThreadSummary[] };
    return body.threads;
  }

  async getThread(id: string): Promise<ThreadDetail> {
    const res = await this.fetchImpl(this.url(`/api/threads/${encodeURIComponent(id)}`), {
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as ThreadDetail;
  }

  async getMessage(id: string): Promise<ThreadMessage> {
    const res = await this.fetchImpl(this.url(`/api/messages/${encodeURIComponent(id)}`), {
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as ThreadMessage;
  }

  // -------------------------------------------------------------- inboxes

  async listInboxes(): Promise<InboxRow[]> {
    const res = await this.fetchImpl(this.url("/api/inboxes"), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    const body = (await res.json()) as { inboxes: InboxRow[] };
    return body.inboxes;
  }

  async getInbox(id: string): Promise<InboxDetail> {
    const res = await this.fetchImpl(this.url(`/api/inboxes/${encodeURIComponent(id)}`), {
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as InboxDetail;
  }

  async createInbox(input: CreateInboxInput): Promise<InboxRow> {
    const res = await this.fetchImpl(this.url("/api/inboxes"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as InboxRow;
  }

  async deleteInbox(id: string): Promise<{ ok: true; id: string }> {
    const res = await this.fetchImpl(this.url(`/api/inboxes/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as { ok: true; id: string };
  }

  async addInboxMember(id: string, userId: string, role: InboxRole): Promise<{ ok: true }> {
    const res = await this.fetchImpl(
      this.url(`/api/inboxes/${encodeURIComponent(id)}/members`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ userId, role }),
      },
    );
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as { ok: true };
  }

  async removeInboxMember(id: string, userId: string): Promise<{ ok: true }> {
    const res = await this.fetchImpl(
      this.url(
        `/api/inboxes/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      ),
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as { ok: true };
  }

  // ---------------------------------------------------------------- audit

  async listAudit(q: AuditQuery = {}): Promise<AuditPage> {
    const url = new URL(this.url("/api/audit"));
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    return (await res.json()) as AuditPage;
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<SearchHit[]> {
    const url = new URL(this.url("/api/search"));
    url.searchParams.set("q", query);
    if (opts.limit) url.searchParams.set("limit", String(opts.limit));
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) await throwHttp(res);
    const body = (await res.json()) as { hits: SearchHit[] };
    return body.hits;
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
      : res.status === 404
        ? "not_found"
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

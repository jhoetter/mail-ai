// Browser-side wrapper around /api/threads. Mirrors oauth-client.ts:
// thin, no shared base class, just enough to fetch + give the inbox
// page a typed shape. Server returns the array under `threads` so we
// stay forward-compatible with paging/cursors later.

import { baseUrl } from "./api";

export interface ThreadSummary {
  id: string;
  providerThreadId: string;
  providerMessageId: string;
  provider: "google-mail" | "outlook";
  subject: string;
  from: string;
  fromEmail: string | null;
  snippet: string;
  unread: boolean;
  labels: string[];
  date: string;
}

export async function listThreads(opts: { limit?: number } = {}): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  const url = `${baseUrl()}/api/threads${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/threads ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { threads: ThreadSummary[] };
  return data.threads;
}

export interface ThreadMessage {
  id: string;
  providerMessageId: string;
  from: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string | null;
  date: string;
  snippet: string;
  unread: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyFetchedAt: string | null;
}

export interface ThreadDetail {
  id: string;
  subject: string;
  providerThreadId: string;
  provider: "google-mail" | "outlook";
  unreadCount: number;
  messages: ThreadMessage[];
}

export async function getThread(id: string): Promise<ThreadDetail> {
  const url = `${baseUrl()}/api/threads/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/threads/${id} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ThreadDetail;
}

// Browser-side wrapper around /api/threads. Mirrors oauth-client.ts:
// thin, no shared base class, just enough to fetch + give the inbox
// page a typed shape. Server returns the array under `threads` so we
// stay forward-compatible with paging/cursors later.

import { apiFetch } from "./api";

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
  tags?: TagSummary[];
  status?: "open" | "snoozed" | "done" | "draft";
  starred?: boolean;
  hasAttachments?: boolean;
}

export interface TagSummary {
  id: string;
  name: string;
  color: string;
}

export async function listThreads(opts: { limit?: number } = {}): Promise<ThreadSummary[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  const url = `/api/threads${params.toString() ? `?${params}` : ""}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/threads ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { threads: ThreadSummary[] };
  return data.threads;
}

export interface ThreadAttachment {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

export interface ThreadMessage {
  id: string;
  providerMessageId: string;
  subject: string | null;
  from: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string | null;
  // Comma-joined recipient strings stored verbatim from the source
  // headers. The InlineReply component splits these into chips when
  // it pre-fills "Reply all". For received mail Bcc is almost
  // always null (only the sender's copy carries it).
  cc: string | null;
  bcc: string | null;
  date: string;
  snippet: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyFetchedAt: string | null;
  attachments: ThreadAttachment[];
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
  const url = `/api/threads/${encodeURIComponent(id)}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/api/threads/${id} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as ThreadDetail;
}

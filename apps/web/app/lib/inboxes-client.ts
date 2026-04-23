// Browser wrapper around /api/inboxes. Mirrors threads-client.ts —
// thin, no shared base, just enough for the settings UI. Multi-tenant
// isolation lives on the server.

import { apiFetch } from "./api";

export type InboxRole = "inbox-admin" | "agent" | "viewer";

export interface InboxRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
}

export interface InboxMember {
  inboxId: string;
  userId: string;
  role: InboxRole;
}

export interface InboxMailbox {
  inboxId: string;
  accountId: string;
  mailboxPath: string;
}

export interface InboxDetail extends InboxRow {
  members: InboxMember[];
  mailboxes: InboxMailbox[];
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.url} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listInboxes(): Promise<InboxRow[]> {
  const res = await apiFetch(`/api/inboxes`);
  const data = await asJson<{ inboxes: InboxRow[] }>(res);
  return data.inboxes;
}

export async function getInbox(id: string): Promise<InboxDetail> {
  const res = await apiFetch(`/api/inboxes/${encodeURIComponent(id)}`);
  return asJson<InboxDetail>(res);
}

export interface CreateInboxInput {
  name: string;
  description?: string | null;
  members?: { userId: string; role: InboxRole }[];
  mailboxes?: { accountId: string; mailboxPath: string }[];
}

export async function createInbox(input: CreateInboxInput): Promise<InboxRow> {
  const res = await apiFetch(`/api/inboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return asJson<InboxRow>(res);
}

export async function deleteInbox(id: string): Promise<void> {
  const res = await apiFetch(`/api/inboxes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await asJson<{ ok: true }>(res);
}

export async function addMember(id: string, userId: string, role: InboxRole): Promise<void> {
  const res = await apiFetch(`/api/inboxes/${encodeURIComponent(id)}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
  await asJson<{ ok: true }>(res);
}

export async function removeMember(id: string, userId: string): Promise<void> {
  const res = await apiFetch(
    `/api/inboxes/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  await asJson<{ ok: true }>(res);
}

export async function addMailbox(
  id: string,
  accountId: string,
  mailboxPath: string,
): Promise<void> {
  const res = await apiFetch(`/api/inboxes/${encodeURIComponent(id)}/mailboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, mailboxPath }),
  });
  await asJson<{ ok: true }>(res);
}

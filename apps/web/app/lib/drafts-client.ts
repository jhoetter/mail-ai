// Drafts list + get. Mutations route through /api/commands.

import { baseUrl } from "./api";
import { dispatchCommand } from "./commands-client";

export interface DraftSummary {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  providerThreadId: string | null;
  replyToMessageId: string | null;
  updatedAt: string;
}

export async function listDrafts(): Promise<DraftSummary[]> {
  const res = await fetch(`${baseUrl()}/api/drafts`);
  if (!res.ok) throw new Error(`/api/drafts ${res.status}`);
  const data = (await res.json()) as { drafts: DraftSummary[] };
  return data.drafts;
}

export async function getDraft(id: string): Promise<DraftSummary | null> {
  const res = await fetch(`${baseUrl()}/api/drafts/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/drafts/${id} ${res.status}`);
  const data = (await res.json()) as { draft: DraftSummary };
  return data.draft;
}

export interface CreateDraftInput {
  accountId?: string;
  replyToMessageId?: string;
  providerThreadId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
}

export async function createDraft(input: CreateDraftInput): Promise<void> {
  await dispatchCommand({ type: "draft:create", payload: input });
}

export async function updateDraft(id: string, patch: Omit<CreateDraftInput, "accountId" | "replyToMessageId" | "providerThreadId">): Promise<void> {
  await dispatchCommand({ type: "draft:update", payload: { id, ...patch } });
}

export async function deleteDraft(id: string): Promise<void> {
  await dispatchCommand({ type: "draft:delete", payload: { id } });
}

export async function sendDraft(id: string): Promise<void> {
  await dispatchCommand({ type: "draft:send", payload: { id } });
}

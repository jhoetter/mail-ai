// Browser-side tag CRUD + per-thread tag listing.
// Mutations route through /api/commands so they hit the audit log.

import { baseUrl } from "./api";
import { dispatchCommand } from "./commands-client";

export interface TagDefinition {
  id: string;
  name: string;
  color: string;
  count?: number;
}

export async function listTags(): Promise<TagDefinition[]> {
  const res = await fetch(`${baseUrl()}/api/tags`);
  if (!res.ok) throw new Error(`/api/tags ${res.status}`);
  const data = (await res.json()) as { tags: TagDefinition[] };
  return data.tags;
}

export async function createTag(name: string, color?: string): Promise<TagDefinition> {
  const res = await fetch(`${baseUrl()}/api/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) throw new Error(`/api/tags create ${res.status}`);
  const data = (await res.json()) as { tag: TagDefinition };
  return data.tag;
}

export async function deleteTag(id: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/tags/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`/api/tags delete ${res.status}`);
}

export async function listThreadTags(threadId: string): Promise<TagDefinition[]> {
  const res = await fetch(`${baseUrl()}/api/threads/${encodeURIComponent(threadId)}/tags`);
  if (!res.ok) throw new Error(`/api/threads/${threadId}/tags ${res.status}`);
  const data = (await res.json()) as { tags: TagDefinition[] };
  return data.tags;
}

export async function addTagToThread(threadId: string, tag: string): Promise<void> {
  await dispatchCommand({ type: "thread:add-tag", payload: { threadId, tag } });
}

export async function removeTagFromThread(threadId: string, tag: string): Promise<void> {
  await dispatchCommand({ type: "thread:remove-tag", payload: { threadId, tag } });
}

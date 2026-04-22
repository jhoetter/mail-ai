// Browser wrapper for /api/audit. Same shape as the other clients.
// Pagination is opaque: pass back nextCursor verbatim.

import { baseUrl } from "./api";

export interface AuditEntry {
  seq: string;
  mutationId: string;
  commandType: string;
  actorId: string;
  source: string;
  status: string;
  payload: unknown;
  diff: unknown;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
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

export async function listAudit(q: AuditQuery = {}): Promise<AuditPage> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const res = await fetch(`${baseUrl()}/api/audit?${params}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`/api/audit ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as AuditPage;
}

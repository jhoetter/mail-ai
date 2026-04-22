// Browser-side wrapper around /api/views. Views are saved
// (filter + sort + group) tabs across the inbox.

import { baseUrl } from "./api";
import type { ThreadSummary } from "./threads-client";

export interface ViewFilter {
  tagsAny?: string[];
  tagsNone?: string[];
  status?: ("open" | "snoozed" | "done")[];
  fromContains?: string;
  unread?: boolean;
  accountIds?: string[];
  kind?: "default" | "drafts" | "sent" | "trash" | "spam" | "all";
}

export interface ViewSummary {
  id: string;
  name: string;
  icon: string | null;
  position: number;
  isBuiltin: boolean;
  filter: ViewFilter;
  sortBy: string;
  groupBy: string | null;
  layout: string;
}

export async function listViews(): Promise<ViewSummary[]> {
  const res = await fetch(`${baseUrl()}/api/views`);
  if (!res.ok) throw new Error(`/api/views ${res.status}`);
  const data = (await res.json()) as { views: ViewSummary[] };
  return data.views;
}

export async function createView(input: {
  name: string;
  icon?: string;
  filter?: ViewFilter;
}): Promise<ViewSummary> {
  const res = await fetch(`${baseUrl()}/api/views`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/api/views create ${res.status}`);
  const data = (await res.json()) as { view: ViewSummary };
  return data.view;
}

export async function updateView(
  id: string,
  patch: Partial<{
    name: string;
    icon: string;
    filter: ViewFilter;
    sortBy: string;
    groupBy: string | null;
    position: number;
  }>,
): Promise<ViewSummary> {
  const res = await fetch(`${baseUrl()}/api/views/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`/api/views update ${res.status}`);
  const data = (await res.json()) as { view: ViewSummary };
  return data.view;
}

export async function deleteView(id: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`/api/views delete ${res.status}`);
}

export interface ViewThreadsResult {
  view: ViewSummary;
  threads: ThreadSummary[];
}

export async function listViewThreads(
  id: string,
  opts: { limit?: number } = {},
): Promise<ViewThreadsResult> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  const url = `${baseUrl()}/api/views/${encodeURIComponent(id)}/threads${
    params.toString() ? `?${params}` : ""
  }`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/api/views threads ${res.status}`);
  return (await res.json()) as ViewThreadsResult;
}

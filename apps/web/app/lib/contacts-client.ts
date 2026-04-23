// Recipient autocomplete client.
//
// Two responsibilities:
//   1. `suggestContacts(q, accountId?)` — fetches /api/contacts/suggest
//      with a sensible client-side abort + debounce window.
//   2. `useDebouncedSuggest` — the hook RecipientField consumes:
//      pass it the live input value and it returns the latest
//      suggestion list, debouncing the network calls so we don't
//      hammer the route on every keystroke.
//
// The server endpoint is index-backed and returns sub-50ms even for
// thousands of contacts, but a 120ms debounce is still the right
// human-perceived latency for "I'm typing" — typing 3 fast chars
// in a row should produce ONE network call, not three.

import { useEffect, useRef, useState } from "react";
import { baseUrl } from "./api";

export type ContactSource = "my" | "other" | "people";

export interface ContactSuggestion {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
  readonly source: ContactSource;
  readonly accountId: string;
}

export interface ReconnectAccount {
  readonly id: string;
  readonly provider: string;
  readonly email: string;
}

export interface SuggestResponse {
  readonly items: ContactSuggestion[];
  readonly reconnect: ReconnectAccount[];
}

const EMPTY_RESPONSE: SuggestResponse = { items: [], reconnect: [] };

export async function suggestContacts(
  q: string,
  opts: { accountId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<SuggestResponse> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return EMPTY_RESPONSE;
  const u = new URL(
    "/api/contacts/suggest",
    typeof window === "undefined" ? "http://localhost" : window.location.href,
  );
  u.searchParams.set("q", trimmed);
  if (opts.accountId) u.searchParams.set("accountId", opts.accountId);
  if (opts.limit) u.searchParams.set("limit", String(opts.limit));
  const path = u.pathname + u.search;
  const res = await fetch(`${baseUrl()}${path}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`/api/contacts/suggest ${res.status}`);
  }
  return (await res.json()) as SuggestResponse;
}

export interface UseSuggestOptions {
  readonly debounceMs?: number;
  readonly accountId?: string;
  readonly limit?: number;
  // When false, the hook is dormant — useful when the dropdown
  // isn't visible yet (e.g. the field hasn't been focused) so we
  // don't speculatively fetch on every input change.
  readonly enabled?: boolean;
}

export interface UseSuggestState {
  readonly items: ContactSuggestion[];
  readonly reconnect: ReconnectAccount[];
  readonly loading: boolean;
}

export function useDebouncedSuggest(query: string, opts: UseSuggestOptions = {}): UseSuggestState {
  const { debounceMs = 120, accountId, limit, enabled = true } = opts;
  const [items, setItems] = useState<ContactSuggestion[]>([]);
  const [reconnect, setReconnect] = useState<ReconnectAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setReconnect([]);
      setLoading(false);
      return undefined;
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      abortRef.current?.abort();
      setItems([]);
      setReconnect([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const callOpts: { accountId?: string; limit?: number; signal: AbortSignal } = {
        signal: ctrl.signal,
      };
      if (accountId) callOpts.accountId = accountId;
      if (limit) callOpts.limit = limit;
      suggestContacts(trimmed, callOpts)
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setItems(res.items);
          setReconnect(res.reconnect);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setItems([]);
          setLoading(false);
        });
    }, debounceMs);
    return () => {
      clearTimeout(handle);
    };
  }, [query, debounceMs, accountId, limit, enabled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { items, reconnect, loading };
}

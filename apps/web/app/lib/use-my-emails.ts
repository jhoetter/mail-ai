// Lookup of "which addresses are me?" — used by the composer to keep
// the user's own address out of Reply-All recipient lists. Driven by
// /api/accounts so it covers every connected mailbox the user owns.
//
// We cache the fetch at module scope: the answer rarely changes
// during a session, and every InlineReply mount otherwise piles up
// duplicate /api/accounts requests. Callers that need a refresh
// (e.g. after the settings page connects a new account) can call
// `invalidateMyEmails()` to clear the cache.

import { useEffect, useState } from "react";
import { listAccounts, type AccountSummary } from "./oauth-client";

let cache: Promise<ReadonlySet<string>> | null = null;

function load(): Promise<ReadonlySet<string>> {
  if (cache) return cache;
  cache = listAccounts()
    .then((rows: AccountSummary[]) => {
      const set = new Set<string>();
      for (const a of rows) {
        const email = a.email?.trim().toLowerCase();
        if (email) set.add(email);
      }
      return set as ReadonlySet<string>;
    })
    .catch(() => new Set<string>() as ReadonlySet<string>);
  return cache;
}

export function invalidateMyEmails(): void {
  cache = null;
}

// Hook returning a lowercase Set of every connected account email.
// Returns an empty set until the first fetch resolves so the caller
// can render synchronously without waiting; treat "empty" as "not
// loaded yet, don't filter anything out".
export function useMyEmails(): ReadonlySet<string> {
  const [emails, setEmails] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    load().then((set) => {
      if (!cancelled) setEmails(set);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return emails;
}

// Provider-agnostic helpers shared by every ContactsProvider adapter
// and by the server's contacts sync handler. Kept in @mailai/providers
// (not @mailai/oauth-tokens) so the handler doesn't have to reach
// into the adapter package for primitive helpers.

import type { NormalizedContactEmail } from "./types.js";

// Pick the address that should land in `oauth_contacts.primary_email`.
// Prefers the flag the provider gave us, falls back to the first
// non-empty entry. Lower-cased so the index-backed prefix lookup in
// the repo is a straight ILIKE without a per-row lower() at query
// time.
export function pickPrimaryEmail(emails: readonly NormalizedContactEmail[]): string | null {
  const primary = emails.find((e) => e.primary);
  const chosen = (primary ?? emails[0])?.address;
  if (!chosen) return null;
  return chosen.trim().toLowerCase();
}

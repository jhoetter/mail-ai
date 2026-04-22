// Pure helpers behind the inbox EmptyView surface.
//
// Lives in app/lib (not next to the component) so the unit-test
// runner — which is node-only and scoped to app/lib/**/*.test.ts —
// can exercise the resolution rules without dragging in React or
// jsdom. The component just imports these and renders.

import type { AccountSummary } from "./oauth-client";
import type { ViewSummary } from "./views-client";

export type EmptyViewKind =
  | "default"
  | "drafts"
  | "sent"
  | "trash"
  | "spam"
  | "all"
  | "filtered";

export function resolveEmptyKind(
  viewId: string | null,
  views: ViewSummary[] | null,
): EmptyViewKind {
  if (!viewId) return "default";
  const view = views?.find((v) => v.id === viewId);
  const kind = view?.filter.kind;
  if (
    kind === "drafts" ||
    kind === "sent" ||
    kind === "trash" ||
    kind === "spam" ||
    kind === "all"
  ) {
    return kind;
  }
  if (view && hasNarrowingFilters(view)) return "filtered";
  return "default";
}

export function hasNarrowingFilters(view: ViewSummary): boolean {
  const f = view.filter;
  return Boolean(
    (f.tagsAny && f.tagsAny.length > 0) ||
      (f.tagsNone && f.tagsNone.length > 0) ||
      // Built-in views (Inbox / Snoozed / Done) all carry a status
      // predicate; that's their defining identity rather than a
      // user-applied narrowing. Treat user-saved status filters as
      // narrowing instead so the empty state nudges them toward
      // loosening rather than onboarding.
      (f.status && f.status.length > 0 && !view.isBuiltin) ||
      f.unread === true ||
      Boolean(f.fromContains && f.fromContains.length > 0) ||
      Boolean(f.accountIds && f.accountIds.length > 0),
  );
}

export function firstSyncError(
  accounts: AccountSummary[] | null,
): string | null {
  if (!accounts) return null;
  for (const a of accounts) {
    if (a.lastSyncError) return a.lastSyncError;
  }
  return null;
}

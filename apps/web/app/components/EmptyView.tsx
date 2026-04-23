// EmptyView is the canonical "nothing to show here" surface for the
// inbox list. It replaces the older `EmptyInbox` component which
// always told the user to "Connect a mailbox" — even when they had
// one connected and the view was just legitimately empty (e.g. Sent
// before any send, or Drafts before any draft). That dishonesty is
// what the Phase 1 reliability work explicitly fixes.
//
// Resolution order, highest specificity first:
//
//   1. The user has *no* connected accounts → onboarding CTA.
//   2. The user has accounts but at least one of them is in a sync
//      error state → reconnect CTA + the actual error message.
//   3. The user has accounts that sync fine but the view filter is
//      narrower than "everything" (status filter, tag filter, etc.)
//      → "no matches" copy + a hint to loosen filters.
//   4. The view is one of the well-known kinds (default / drafts /
//      sent / all) → kind-specific copy.
//
// Copy lives in the i18n catalogue under `emptyView.*` so neither
// the surface nor the embedding host (hof-os) needs to fork.

import { AlertTriangle, Inbox as InboxIcon } from "lucide-react";
import { useTranslator } from "../lib/i18n/useTranslator";
import type { EmptyViewKind } from "../lib/empty-view";

export type { EmptyViewKind };

interface Props {
  // The view kind being rendered. Driven by the active view's
  // filter.kind; defaults to "default" for the catch-all inbox.
  kind: EmptyViewKind;
  // Whether the user has any connected accounts at all. Drives the
  // onboarding CTA branch.
  hasAccounts: boolean;
  // The most recent sync error across the user's accounts, if any.
  // Populated by the parent from /api/accounts.lastSyncError. We
  // surface the first non-null one so the user is never left
  // wondering why nothing is syncing.
  lastSyncError?: string | null;
}

const ACCOUNTS_HREF = "/settings/account";

export function EmptyView({ kind, hasAccounts, lastSyncError }: Props) {
  const { t } = useTranslator();

  if (!hasAccounts) {
    return (
      <Layout
        icon={<InboxIcon size={20} aria-hidden className="text-tertiary" />}
        title={t("emptyView.noAccountsTitle")}
        hint={t("emptyView.noAccountsHint")}
        cta={
          <a
            href={ACCOUNTS_HREF}
            data-testid="empty-view-cta-accounts"
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-background hover:opacity-90"
          >
            {t("emptyView.goToAccounts")}
          </a>
        }
      />
    );
  }

  if (lastSyncError) {
    return (
      <Layout
        icon={<AlertTriangle size={20} aria-hidden className="text-warning" />}
        title={t("emptyView.syncErrorTitle")}
        hint={t("emptyView.syncErrorHint")}
        details={t("emptyView.syncErrorDetails", { error: lastSyncError })}
        cta={
          <a
            href={ACCOUNTS_HREF}
            data-testid="empty-view-cta-reconnect"
            className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-background hover:opacity-90"
          >
            {t("emptyView.openAccounts")}
          </a>
        }
      />
    );
  }

  const titleKey = `emptyView.${kind}.title`;
  const hintKey = `emptyView.${kind}.hint`;

  return (
    <Layout
      icon={<InboxIcon size={20} aria-hidden className="text-tertiary" />}
      title={t(titleKey)}
      hint={t(hintKey)}
    />
  );
}

interface LayoutProps {
  icon: React.ReactNode;
  title: string;
  hint: string;
  details?: string;
  cta?: React.ReactNode;
}

function Layout({ icon, title, hint, details, cta }: LayoutProps) {
  return (
    <div data-testid="empty-view" className="flex flex-col items-start gap-3 py-6">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="max-w-md text-sm text-secondary">{hint}</p>
      {details ? <p className="max-w-md break-words text-xs text-tertiary">{details}</p> : null}
      {cta}
    </div>
  );
}

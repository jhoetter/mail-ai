import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import type { AccountSummary } from "../lib/oauth-client";
import { getCachedAccounts, loadAccountsCached } from "../lib/accounts-cache";
import { useSyncEvents } from "../lib/realtime";
import { useTranslator } from "../lib/i18n/useTranslator";

type Tone = "live" | "warning" | "offline" | "loading";

interface Props {
  /**
   * "mail" / "calendar" only changes the tooltip phrasing; both surfaces
   * read the same `oauth_accounts` rows because OAuth credentials and
   * tokens are shared per provider account.
   */
  readonly surface: "mail" | "calendar";
}

/**
 * Pill showing whether the OAuth account(s) backing the current surface
 * have a usable access token and have completed a recent sync.
 *
 * Body fetches and calendar reads are lazy — they hit the provider on
 * demand. Without a live token the cached metadata still renders, but
 * never-opened message bodies stay blank and new events stop arriving.
 * Surfacing this state here keeps "why is my mail empty" debugging
 * close to the place it bites.
 */
export function ConnectionStatus({ surface }: Props) {
  const { t } = useTranslator();
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(() => getCachedAccounts());
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useMemo(
    () => () => {
      loadAccountsCached({ force: true })
        .then((rows) => {
          setAccounts(rows);
          setLoadError(null);
        })
        .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    },
    [],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Sync events touch oauth_accounts (lastSyncedAt); refetch keeps the pill live. */
  useSyncEvents(refresh);

  const tone = computeTone(accounts, loadError);
  const label = labelFor(tone, t);
  const tooltip = tooltipFor({ surface, accounts, loadError, t });

  const dotClass =
    tone === "live"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "offline"
          ? "bg-error"
          : "bg-tertiary";

  return (
    <Link
      to="/settings/account"
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex items-center gap-1.5 rounded-full border border-divider bg-surface px-2 py-0.5 text-[11px] text-secondary transition-colors hover:border-foreground/30 hover:text-foreground"
    >
      <span aria-hidden className="relative inline-flex h-2 w-2">
        {tone === "live" ? (
          <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
        ) : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClass}`} />
      </span>
      <span>{label}</span>
    </Link>
  );
}

function computeTone(accounts: AccountSummary[] | null, loadError: string | null): Tone {
  if (loadError) return "offline";
  if (accounts === null) return "loading";
  if (accounts.length === 0) return "offline";
  const hasRevoked = accounts.some((a) => a.status === "revoked");
  if (hasRevoked) return "offline";
  const needsReauth = accounts.some((a) => a.status === "needs-reauth");
  if (needsReauth) return "warning";
  /** Surface a `lastSyncError` as warning so the pill isn't lying about freshness. */
  if (accounts.some((a) => a.lastSyncError)) return "warning";
  return "live";
}

function labelFor(tone: Tone, t: (k: string) => string): string {
  switch (tone) {
    case "live":
      return t("connection.live");
    case "warning":
      return t("connection.warning");
    case "offline":
      return t("connection.offline");
    case "loading":
      return t("connection.loading");
    default: {
      const _exhaustive: never = tone;
      void _exhaustive;
      return "";
    }
  }
}

function tooltipFor(args: {
  surface: "mail" | "calendar";
  accounts: AccountSummary[] | null;
  loadError: string | null;
  t: (k: string) => string;
}): string {
  const { surface, accounts, loadError, t } = args;
  if (loadError) return `${t("connection.errorPrefix")}: ${loadError}`;
  if (accounts === null) return t("connection.loading");
  if (accounts.length === 0) {
    return surface === "calendar" ? t("connection.noCalendarAccounts") : t("connection.noMailAccounts");
  }
  const lines = accounts.map((a) => {
    const state =
      a.status === "ok"
        ? a.lastSyncError
          ? `${t("connection.statusOk")} (${t("connection.lastSyncError")})`
          : t("connection.statusOk")
        : a.status === "needs-reauth"
          ? t("connection.statusNeedsReauth")
          : t("connection.statusRevoked");
    return `${a.email} — ${state}`;
  });
  return lines.join("\n");
}

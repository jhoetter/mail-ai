import { useCallback, useEffect, useState } from "react";
import { Button, Card, DataTable, PageBody, PageHeader, Shell } from "@mailai/ui";
import { ConnectAccountDialog } from "../../components/connect-account-dialog";
import { AppNav } from "../../components/AppNav";
import { SignatureCard } from "../../components/SignatureCard";
import {
  type AccountSummary,
  deleteAccount,
  listAccounts,
  syncAccount,
} from "../../lib/oauth-client";
import { LocaleToggle } from "../../lib/i18n/LocaleToggle";
import { useTranslator } from "../../lib/i18n/useTranslator";

interface AccountRow extends AccountSummary {
  // Plain-data row only — JSX renderers live in the columns def so the
  // DataTable's `String(row[c.key])` fallback never sees a React node
  // and stringifies it to "[object Object]".
}

export default function AccountSettingsPage() {
  const { t } = useTranslator();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setAccounts(await listAccounts());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDisconnect = useCallback(
    async (id: string) => {
      if (!confirm("Disconnect this account? mail-ai will stop fetching mail for it.")) {
        return;
      }
      try {
        await deleteAccount(id);
        await refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const onSync = useCallback(
    async (id: string) => {
      setSyncingId(id);
      try {
        const r = await syncAccount(id);
        await refresh();
        // Visible feedback so "Sync now" never feels like a no-op when
        // 0 new messages came back.
        const verb =
          r.inserted > 0
            ? `${r.inserted} new`
            : r.updated > 0
              ? `${r.updated} updated`
              : "no changes";
        // eslint-disable-next-line no-alert -- intentional, swap for toast later
        alert(`Synced ${r.fetched} messages (${verb}) in ${r.durationMs} ms`);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      } finally {
        setSyncingId(null);
      }
    },
    [refresh],
  );

  const rows: AccountRow[] = accounts;

  return (
    <Shell sidebar={<AppNav />}>
      <PageHeader
        title={t("accounts.title")}
        subtitle={t("accounts.subtitle")}
        actions={
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            {t("accounts.connectGmail")}
          </Button>
        }
      />
      <PageBody>
      <Card>
        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <p className="text-sm font-medium">{t("common.language")}</p>
            <p className="text-xs text-secondary">
              {t("common.english")} / {t("common.german")}
            </p>
          </div>
          <LocaleToggle />
        </div>
      </Card>
      <Card>
        {loadError ? (
          <p className="text-sm text-error">
            Couldn&apos;t load accounts: {loadError}
          </p>
        ) : loading ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState onConnect={() => setOpen(true)} />
        ) : (
          <DataTable<AccountRow>
            rows={rows}
            columns={[
              {
                key: "provider",
                header: "Provider",
                render: (r) => providerLabel(r.provider),
              },
              { key: "email", header: "Email" },
              {
                key: "status",
                header: "Status",
                render: (r) => (
                  <span
                    className={
                      r.status === "ok"
                        ? "text-success"
                        : r.status === "needs-reauth"
                          ? "text-warning"
                          : "text-error"
                    }
                  >
                    {statusLabel(r.status)}
                  </span>
                ),
              },
              {
                key: "lastSyncedAt",
                header: "Last synced",
                render: (r) => (
                  <span className="text-secondary">
                    {r.lastSyncError
                      ? `error: ${truncate(r.lastSyncError, 60)}`
                      : r.lastSyncedAt
                        ? formatRelative(new Date(r.lastSyncedAt))
                        : "never"}
                  </span>
                ),
              },
              {
                key: "id",
                header: "",
                render: (r) => (
                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={syncingId === r.id}
                      onClick={() => void onSync(r.id)}
                    >
                      {syncingId === r.id ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onDisconnect(r.id)}
                    >
                      Disconnect
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <SignatureCard />
      </PageBody>

      <ConnectAccountDialog
        open={open}
        onClose={() => setOpen(false)}
        onConnected={() => {
          void refresh();
        }}
      />
    </Shell>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Coarse human-friendly relative time. We intentionally don't pull in
// a date library for a single label.
function formatRelative(d: Date): string {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-sm text-secondary">
        No accounts connected yet. Connect Gmail or Outlook to start syncing
        mail into mail-ai.
      </p>
      <Button variant="primary" size="sm" onClick={onConnect}>
        Connect your first account
      </Button>
    </div>
  );
}

function providerLabel(p: string): string {
  if (p === "google-mail") return "Gmail";
  if (p === "outlook") return "Outlook";
  return p;
}

function statusLabel(s: AccountSummary["status"]): string {
  if (s === "ok") return "Connected";
  if (s === "needs-reauth") return "Re-auth required";
  return "Revoked";
}


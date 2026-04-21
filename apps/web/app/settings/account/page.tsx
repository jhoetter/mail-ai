"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, DataTable, PageHeader, Shell } from "@mailai/ui";
import { ConnectAccountDialog } from "../../components/connect-account-dialog";
import {
  type AccountSummary,
  deleteAccount,
  listAccounts,
} from "../../lib/oauth-client";

export default function AccountSettingsPage() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  const rows = accounts.map((a) => ({
    id: a.id,
    provider: providerLabel(a.provider),
    email: a.email,
    status: statusLabel(a.status),
    actions: (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onDisconnect(a.id)}
      >
        Disconnect
      </Button>
    ),
  }));

  return (
    <Shell sidebar={<SettingsSidebar />}>
      <PageHeader
        title="Accounts"
        subtitle="Connected mail accounts. mail-ai never modifies what it didn't ask for."
        actions={
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Connect account
          </Button>
        }
      />
      <Card>
        {loadError ? (
          <p className="text-sm text-danger">
            Couldn&apos;t load accounts: {loadError}
          </p>
        ) : loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState onConnect={() => setOpen(true)} />
        ) : (
          <DataTable
            rows={rows}
            columns={[
              { key: "provider", header: "Provider" },
              { key: "email", header: "Email" },
              { key: "status", header: "Status" },
              { key: "actions", header: "" },
            ]}
          />
        )}
      </Card>

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

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-sm text-muted">
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

function SettingsSidebar() {
  return (
    <nav className="flex flex-col gap-2 text-sm">
      <a href="/inbox" className="text-muted">Inbox</a>
      <a href="/settings/account" className="font-medium">Accounts</a>
      <a href="/settings/inboxes" className="text-muted">Inboxes</a>
      <a href="/settings/agents" className="text-muted">Agents</a>
      <a href="/settings/audit" className="text-muted">Audit</a>
    </nav>
  );
}

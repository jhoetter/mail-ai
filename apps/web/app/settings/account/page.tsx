"use client";

import { useEffect, useState } from "react";
import { Button, Card, DataTable, Dialog, PageHeader, Shell } from "@mailai/ui";

interface AccountRow {
  id: string;
  provider: string;
  address: string;
  status: "ok" | "needs-reauth" | "syncing";
}

export default function AccountSettingsPage() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setRows([
      { id: "demo-1", provider: "imap", address: "alice@example.com", status: "ok" },
    ]);
  }, []);

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
        <DataTable
          rows={rows}
          columns={[
            { key: "provider", header: "Provider" },
            { key: "address", header: "Address" },
            { key: "status", header: "Status" },
          ]}
        />
      </Card>

      <Dialog open={open} onClose={() => setOpen(false)}>
        <h2 className="text-lg font-semibold">Connect a mail account</h2>
        <p className="mt-2 text-sm text-muted">
          OAuth (Google / Microsoft) and IMAP password connectors run through the
          headless agent. Pick one to get started:
        </p>
        <ul className="mt-4 space-y-3 text-sm">
          <li>
            <span className="font-medium">OAuth (Google / Microsoft)</span>
            <pre className="mt-1 rounded-md border border-border bg-surface p-2 text-xs overflow-x-auto">
mail-agent auth login --provider google
mail-agent auth login --provider microsoft
            </pre>
          </li>
          <li>
            <span className="font-medium">IMAP / SMTP password</span>
            <pre className="mt-1 rounded-md border border-border bg-surface p-2 text-xs overflow-x-auto">
mail-agent account add \
  --imap-host imap.example.com --imap-user me@example.com \
  --smtp-host smtp.example.com
            </pre>
          </li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Dialog>
    </Shell>
  );
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

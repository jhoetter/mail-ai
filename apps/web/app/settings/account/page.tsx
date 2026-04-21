"use client";

import { useEffect, useState } from "react";
import { Button, Card, DataTable, PageHeader, Shell } from "@mailai/ui";

interface AccountRow {
  id: string;
  provider: string;
  address: string;
  status: "ok" | "needs-reauth" | "syncing";
}

export default function AccountSettingsPage() {
  const [rows, setRows] = useState<AccountRow[]>([]);

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
          <Button variant="primary" size="sm">
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

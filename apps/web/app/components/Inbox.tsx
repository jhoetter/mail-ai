"use client";

import { Card, DataTable, PageHeader, Shell, Button } from "@mailai/ui";
import { useState } from "react";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";

interface ThreadRow {
  id: string;
  subject: string;
  from: string;
  status: string;
  unread: boolean;
}

const DEMO: ThreadRow[] = [
  { id: "t_1", subject: "Welcome to mail-ai", from: "Alice", status: "open", unread: true },
  { id: "t_2", subject: "Q3 numbers", from: "Bob", status: "open", unread: false },
  { id: "t_3", subject: "Triage review", from: "Carol", status: "snoozed", unread: false },
];

// Inbox is the canonical entry surface. apps/web mounts it directly;
// @mailai/react-app re-exports it so embedding hosts (hof-os) get the
// exact same component, no copy/paste drift.
export function Inbox() {
  const [selected, setSelected] = useState<ThreadRow | null>(null);
  const [composing, setComposing] = useState(false);

  return (
    <Shell
      sidebar={
        <nav className="flex flex-col gap-2 text-sm">
          <a href="#" className="font-medium">Inbox</a>
          <a href="#" className="text-muted">Assigned to me</a>
          <a href="#" className="text-muted">Pending review</a>
        </nav>
      }
    >
      <PageHeader
        title="Inbox"
        actions={
          <Button onClick={() => setComposing(true)} variant="primary" size="sm">
            New
          </Button>
        }
      />
      <div className="grid grid-cols-[1fr_2fr] gap-4">
        <Card>
          <DataTable
            rows={DEMO}
            columns={[
              { key: "subject", header: "Subject" },
              { key: "from", header: "From" },
              { key: "status", header: "Status" },
            ]}
            onRowClick={setSelected}
          />
        </Card>
        <Card>
          {selected ? (
            <ThreadView threadId={selected.id} subject={selected.subject} />
          ) : (
            <p className="text-sm text-muted">Select a thread.</p>
          )}
        </Card>
      </div>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </Shell>
  );
}

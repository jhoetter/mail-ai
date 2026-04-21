"use client";

import { useEffect, useState } from "react";
import { Button, Card, DataTable, PageHeader, Shell } from "@mailai/ui";
import { client } from "@/lib/api";
import { useShortcut } from "@/lib/use-shortcut";
import type { Mutation } from "@mailai/core";

interface PendingRow {
  id: string;
  type: string;
  actor: string;
  age: string;
}

function age(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export default function PendingPage() {
  const [items, setItems] = useState<Mutation[]>([]);
  const [selected, setSelected] = useState<PendingRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await client().listPending();
      setItems(list);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);

  async function approve() {
    if (!selected) return;
    setBusy("approve");
    try {
      await client().approve(selected.id);
      await refresh();
      setSelected(null);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!selected) return;
    const reason = window.prompt("Reason?") ?? undefined;
    setBusy("reject");
    try {
      await client().reject(selected.id, reason);
      await refresh();
      setSelected(null);
    } finally {
      setBusy(null);
    }
  }

  useShortcut([
    { key: "y", run: approve, description: "Approve highlighted" },
    { key: "n", run: reject, description: "Reject highlighted" },
  ]);

  const rows: PendingRow[] = items.map((m) => ({
    id: m.id,
    type: m.command.type,
    actor: m.command.actorId,
    age: age(m.createdAt),
  }));

  return (
    <Shell sidebar={<PendingSidebar />}>
      <PageHeader title="Pending approvals" subtitle={`${items.length} awaiting review`} />
      <div className="grid grid-cols-[2fr_1fr] gap-4">
        <Card>
          <DataTable
            rows={rows}
            columns={[
              { key: "type", header: "Command" },
              { key: "actor", header: "Actor" },
              { key: "age", header: "Age" },
            ]}
            onRowClick={setSelected}
          />
        </Card>
        <Card>
          {selected ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{selected.type}</h2>
              <p className="text-xs text-muted">{selected.id}</p>
              <p className="text-sm">Proposed by {selected.actor} · {selected.age} ago</p>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" onClick={approve} disabled={busy !== null}>
                  Approve (y)
                </Button>
                <Button size="sm" variant="secondary" onClick={reject} disabled={busy !== null}>
                  Reject (n)
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">Select a pending mutation.</p>
          )}
        </Card>
      </div>
    </Shell>
  );
}

function PendingSidebar() {
  return (
    <nav className="flex flex-col gap-2 text-sm">
      <a href="/inbox" className="text-muted">Inbox</a>
      <a href="/pending" className="font-medium">Pending review</a>
      <a href="/search" className="text-muted">Search</a>
      <a href="/settings/account" className="text-muted">Settings</a>
    </nav>
  );
}

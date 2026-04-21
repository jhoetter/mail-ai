"use client";

import { Card, DataTable, PageHeader, Shell, Button } from "@mailai/ui";
import { useCallback, useEffect, useState } from "react";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { listThreads, type ThreadSummary } from "../lib/threads-client";

interface ThreadRow {
  id: string;
  subject: string;
  from: string;
  status: string;
  unread: boolean;
  snippet: string;
  date: string;
}

// Inbox is the canonical entry surface. apps/web mounts it directly;
// @mailai/react-app re-exports it so embedding hosts (hof-os) get the
// exact same component, no copy/paste drift.
//
// Reads from /api/threads (the OAuth REST sync drops messages there
// during onboarding + on every "Sync now"). When that's empty we
// surface a real onboarding state instead of demo data — getting an
// inbox of "Welcome to mail-ai" / "Q3 numbers" right after connecting
// a real Gmail was the dishonest thing the previous version did.
export function Inbox() {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ThreadRow | null>(null);
  const [composing, setComposing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    listThreads({ limit: 100 })
      .then((t) => {
        if (!cancelled) setThreads(t);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setThreads([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const rows: ThreadRow[] =
    threads?.map((t) => ({
      id: t.id,
      subject: t.subject,
      from: t.from,
      status: t.unread ? "unread" : "read",
      unread: t.unread,
      snippet: t.snippet,
      date: t.date,
    })) ?? [];

  return (
    <Shell
      sidebar={
        <nav className="flex flex-col gap-2 text-sm">
          <a href="/inbox" className="font-medium">
            Inbox
          </a>
          <a href="/settings/account" className="text-muted">
            Accounts
          </a>
        </nav>
      }
    >
      <PageHeader
        title="Inbox"
        actions={
          <div className="flex gap-2">
            <Button onClick={refresh} variant="ghost" size="sm">
              Refresh
            </Button>
            <Button onClick={() => setComposing(true)} variant="primary" size="sm">
              New
            </Button>
          </div>
        }
      />
      <div className="grid grid-cols-[1fr_2fr] gap-4">
        <Card>
          {loadError ? (
            <p className="text-sm text-danger">
              Couldn&apos;t load inbox: {loadError}
            </p>
          ) : threads === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyInbox />
          ) : (
            <DataTable<ThreadRow>
              rows={rows}
              columns={[
                {
                  key: "subject",
                  header: "Subject",
                  render: (r) => (
                    <div className="flex flex-col">
                      <span className={r.unread ? "font-semibold" : ""}>
                        {r.subject}
                      </span>
                      <span className="text-xs text-muted truncate max-w-md">
                        {r.snippet}
                      </span>
                    </div>
                  ),
                },
                {
                  key: "from",
                  header: "From",
                  render: (r) => (
                    <span className={r.unread ? "font-semibold" : ""}>{r.from}</span>
                  ),
                },
                {
                  key: "date",
                  header: "Date",
                  render: (r) => (
                    <span className="text-xs text-muted">{formatShort(r.date)}</span>
                  ),
                },
              ]}
              onRowClick={setSelected}
            />
          )}
        </Card>
        <Card>
          {selected ? (
            <ThreadView threadId={selected.id} subject={selected.subject} />
          ) : (
            <p className="text-sm text-muted">
              {rows.length > 0 ? "Select a thread." : "No mail to display."}
            </p>
          )}
        </Card>
      </div>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </Shell>
  );
}

function EmptyInbox() {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-sm font-medium">No mail synced yet.</p>
      <p className="text-sm text-muted max-w-md">
        Connect a Gmail or Outlook account to start syncing mail into mail-ai.
        We pull recent inbox metadata over OAuth so you can triage without
        leaving the page.
      </p>
      <a
        href="/settings/account"
        className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-bg hover:opacity-90"
      >
        Go to Accounts →
      </a>
    </div>
  );
}

function formatShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

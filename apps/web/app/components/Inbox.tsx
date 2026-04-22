"use client";

import { Card, DataTable, PageHeader, Shell, Button } from "@mailai/ui";
import { Pencil, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { AppNav } from "./AppNav";
import { listThreads, type ThreadSummary, type TagSummary } from "../lib/threads-client";
import { useTranslator } from "../lib/i18n/useTranslator";
import { useRegisterPaletteCommands } from "../lib/shell";
import { ReadOnlyChips } from "./TagChips";
import { ViewTabs, useActiveView } from "./ViewTabs";
import { listViewThreads } from "../lib/views-client";

interface ThreadRow {
  id: string;
  subject: string;
  from: string;
  status: string;
  unread: boolean;
  snippet: string;
  date: string;
  tags: TagSummary[];
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
  const { t } = useTranslator();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ThreadRow | null>(null);
  const [composing, setComposing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const { viewId, setViewId } = useActiveView();

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setThreads(null);
    const loader = viewId
      ? listViewThreads(viewId, { limit: 100 }).then((res) => res.threads)
      : listThreads({ limit: 100 });
    loader
      .then((rows) => {
        if (!cancelled) setThreads(rows);
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
  }, [refreshTick, viewId]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Contribute Inbox-scoped palette commands. When the page unmounts
  // these vanish from Cmd+K automatically.
  const inboxCommands = useMemo(
    () => [
      {
        id: "compose-new",
        label: t("commands.compose-new.label"),
        hint: t("commands.compose-new.description"),
        section: t("palette.groupActions"),
        shortcut: "c",
        run: () => setComposing(true),
      },
      {
        id: "inbox-refresh",
        label: t("common.refresh"),
        section: t("palette.groupActions"),
        run: refresh,
      },
    ],
    [t, refresh],
  );
  useRegisterPaletteCommands(inboxCommands);

  const rows: ThreadRow[] =
    threads?.map((t) => ({
      id: t.id,
      subject: t.subject,
      from: t.from,
      status: t.unread ? "unread" : "read",
      unread: t.unread,
      snippet: t.snippet,
      date: t.date,
      tags: t.tags ?? [],
    })) ?? [];

  return (
    <Shell sidebar={<AppNav />}>
      <PageHeader
        title={t("inbox.title")}
        actions={
          <div className="flex gap-2">
            <Button onClick={refresh} variant="ghost" size="sm">
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw size={14} aria-hidden />
                {t("common.refresh")}
              </span>
            </Button>
            <Button onClick={() => setComposing(true)} variant="primary" size="sm">
              <span className="inline-flex items-center gap-1.5">
                <Pencil size={14} aria-hidden />
                {t("common.new")}
              </span>
            </Button>
          </div>
        }
      />
      <ViewTabs activeId={viewId} onChange={setViewId} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,360px)_1fr] gap-4">
        <Card className="flex min-h-0 flex-col overflow-hidden p-0">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadError ? (
              <p className="p-4 text-sm text-error">
                {t("inbox.loadError", { error: loadError })}
              </p>
            ) : threads === null ? (
              <p className="p-4 text-sm text-secondary">{t("inbox.loading")}</p>
            ) : rows.length === 0 ? (
              <div className="p-4">
                <EmptyInbox />
              </div>
            ) : (
              <DataTable<ThreadRow>
                rows={rows}
                columns={[
                  {
                    key: "subject",
                    header: t("inbox.columnSubject"),
                    render: (r) => (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={
                              "truncate text-sm " + (r.unread ? "font-semibold" : "font-medium")
                            }
                          >
                            {r.from}
                          </span>
                          <span className="shrink-0 text-[11px] text-tertiary">
                            {formatShort(r.date)}
                          </span>
                        </div>
                        <span className={"truncate text-sm " + (r.unread ? "font-medium" : "")}>
                          {r.subject}
                        </span>
                        <span className="truncate text-xs text-secondary">{r.snippet}</span>
                        {r.tags.length > 0 ? (
                          <div className="mt-1">
                            <ReadOnlyChips tags={r.tags} compact />
                          </div>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
                onRowClick={setSelected}
              />
            )}
          </div>
        </Card>
        <Card className="flex min-h-0 flex-col overflow-hidden">
          {selected ? (
            <ThreadView threadId={selected.id} subject={selected.subject} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-secondary">
                {rows.length > 0 ? t("inbox.selectThread") : t("inbox.nothingToShow")}
              </p>
            </div>
          )}
        </Card>
      </div>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </Shell>
  );
}

function EmptyInbox() {
  const { t } = useTranslator();
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <p className="text-sm font-medium">{t("inbox.emptyTitle")}</p>
      <p className="text-sm text-secondary max-w-md">{t("inbox.emptyHint")}</p>
      <a
        href="/settings/account"
        className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm text-background hover:opacity-90"
      >
        {t("inbox.goToAccounts")}
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

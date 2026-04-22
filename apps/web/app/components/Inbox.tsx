import { PageHeader, Shell, Button } from "@mailai/ui";
import { Inbox as InboxIcon, Paperclip, Pencil, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { AppNav } from "./AppNav";
import { EmptyView } from "./EmptyView";
import { listThreads, type ThreadSummary, type TagSummary } from "../lib/threads-client";
import { useTranslator } from "../lib/i18n/useTranslator";
import { useRegisterPaletteCommands } from "../lib/shell";
import { dispatchCommand } from "../lib/commands-client";
import { ReadOnlyChips } from "./TagChips";
import { useActiveView } from "./ViewTabs";
import { listViewThreads, listViews, type ViewSummary } from "../lib/views-client";
import { listAccounts, type AccountSummary } from "../lib/oauth-client";
import { firstSyncError, resolveEmptyKind } from "../lib/empty-view";
import { useSyncEvents } from "../lib/realtime";

interface ThreadRow {
  id: string;
  providerMessageId: string;
  subject: string;
  from: string;
  status: string;
  unread: boolean;
  snippet: string;
  date: string;
  tags: TagSummary[];
  starred: boolean;
  hasAttachments: boolean;
  labels: string[];
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
  const { viewId } = useActiveView();
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);

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

  // Load accounts state once per refresh tick. The empty-state branch
  // needs to know (a) whether the user has any connected accounts at
  // all, and (b) whether the most recent sync failed — both of which
  // change the call to action drastically.
  useEffect(() => {
    let cancelled = false;
    listAccounts()
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Background SyncScheduler publishes a `sync` event on the realtime
  // ws after each successful provider pull. We just bump the same
  // refresh tick that the manual `Aktualisieren` button uses, so any
  // newly-arrived rows show up without the user clicking anything.
  useSyncEvents(refresh);

  // Inbox needs the view set to (a) resolve the active id back to a
  // ViewSummary for the empty-state branch and (b) keep the data
  // fresh after the SyncScheduler creates new ones. The sidebar
  // (AppNav → MailViewsNav) does its own fetch for the nav links.
  useEffect(() => {
    let cancelled = false;
    listViews()
      .then((rows) => !cancelled && setViews(rows))
      .catch(() => !cancelled && setViews([]));
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

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
      providerMessageId: t.providerMessageId,
      subject: t.subject,
      from: t.from,
      status: t.unread ? "unread" : "read",
      unread: t.unread,
      snippet: t.snippet,
      date: t.date,
      tags: t.tags ?? [],
      starred: !!t.starred,
      hasAttachments: !!t.hasAttachments,
      labels: t.labels ?? [],
    })) ?? [];

  const onToggleStar = useCallback(
    (row: ThreadRow) => {
      const next = !row.starred;
      // Optimistic patch
      setThreads((prev) =>
        prev
          ? prev.map((tr) => (tr.id === row.id ? { ...tr, starred: next } : tr))
          : prev,
      );
      void dispatchCommand({
        type: "mail:star",
        payload: { providerMessageId: row.providerMessageId, starred: next },
      })
        .catch(() => {
          setThreads((prev) =>
            prev
              ? prev.map((tr) =>
                  tr.id === row.id ? { ...tr, starred: !next } : tr,
                )
              : prev,
          );
        });
    },
    [],
  );

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
      {/*
        Two-pane layout on desktop (≥ md), single-pane on phones/tablets.
        On mobile the list and the thread are mutually exclusive: tapping
        a row swaps the visible pane. The detail pane gets a back button
        in its header (rendered inside ThreadView) to come back to the
        list. We toggle visibility with Tailwind utilities rather than
        unmounting so the list scroll position is preserved when going
        back into a thread.
      */}
      <div className="flex min-h-0 flex-1 md:grid md:grid-cols-[minmax(280px,360px)_1fr]">
        <section
          className={
            "flex min-h-0 flex-1 flex-col overflow-hidden border-divider bg-background md:flex-initial md:border-r " +
            (selected ? "hidden md:flex" : "flex")
          }
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadError ? (
              <p className="px-4 py-3 text-sm text-error">
                {t("inbox.loadError", { error: loadError })}
              </p>
            ) : threads === null ? (
              <p className="px-4 py-3 text-sm text-secondary">{t("inbox.loading")}</p>
            ) : rows.length === 0 ? (
              <div className="px-4 py-3">
                <EmptyView
                  kind={resolveEmptyKind(viewId, views)}
                  hasAccounts={(accounts?.length ?? 0) > 0}
                  lastSyncError={firstSyncError(accounts)}
                />
              </div>
            ) : (
              <ul className="flex flex-col gap-px p-1">
                {rows.map((r) => {
                  const isActive = selected?.id === r.id;
                  return (
                    <li
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isActive}
                      onClick={() => setSelected(r)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(r);
                        }
                      }}
                      className={
                        "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors focus:outline-none " +
                        (isActive
                          ? "bg-accent-light text-foreground"
                          : "hover:bg-hover focus:bg-hover")
                      }
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleStar(r);
                        }}
                        title={r.starred ? t("inbox.unstar") : t("inbox.star")}
                        aria-label={r.starred ? t("inbox.unstar") : t("inbox.star")}
                        className={
                          "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors " +
                          (r.starred
                            ? "text-amber-500 hover:text-amber-600"
                            : "text-tertiary hover:text-foreground")
                        }
                      >
                        <Star
                          size={13}
                          aria-hidden
                          fill={r.starred ? "currentColor" : "none"}
                        />
                      </button>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className={
                              "truncate text-sm " +
                              (r.unread ? "font-semibold text-foreground" : "text-foreground")
                            }
                          >
                            {r.from}
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            {r.hasAttachments ? (
                              <Paperclip
                                size={11}
                                aria-hidden
                                className="text-tertiary"
                              />
                            ) : null}
                            <span className="text-[11px] text-tertiary tabular-nums">
                              {formatShort(r.date)}
                            </span>
                          </div>
                        </div>
                        <span
                          className={
                            "truncate text-sm " +
                            (r.unread ? "font-medium text-foreground" : "text-secondary")
                          }
                        >
                          {r.subject}
                        </span>
                        <span className="truncate text-xs text-tertiary">
                          {r.snippet}
                        </span>
                        {r.tags.length > 0 || r.labels.length > 0 ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {r.tags.length > 0 ? (
                              <ReadOnlyChips tags={r.tags} compact />
                            ) : null}
                            {r.labels
                              .filter((l) => !isSystemLabel(l))
                              .slice(0, 4)
                              .map((label) => (
                                <span
                                  key={label}
                                  className="rounded border border-divider bg-background px-1.5 py-0 text-[10px] text-tertiary"
                                >
                                  {label}
                                </span>
                              ))}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
        <section
          className={
            "min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex " +
            (selected ? "flex" : "hidden md:flex")
          }
        >
          {selected ? (
            <ThreadView
              threadId={selected.id}
              subject={selected.subject}
              onBack={() => setSelected(null)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <InboxIcon size={28} aria-hidden className="text-tertiary" />
              <p className="text-sm text-tertiary">
                {rows.length > 0 ? t("inbox.selectThread") : t("inbox.nothingToShow")}
              </p>
            </div>
          )}
        </section>
      </div>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </Shell>
  );
}

function isSystemLabel(label: string): boolean {
  // Phase 3 moved Inbox / Sent / Drafts / Trash / Spam out of
  // labels_json and into oauth_messages.well_known_folder, so they
  // no longer appear here as labels. What remains are provider-side
  // flags and Gmail's CATEGORY_* meta-labels — we surface unread /
  // starred via dedicated chips already, and the categories are
  // noise for end users, so hide all of them.
  const sys = new Set([
    "UNREAD",
    "STARRED",
    "IMPORTANT",
    "CHAT",
    "CATEGORY_PERSONAL",
    "CATEGORY_SOCIAL",
    "CATEGORY_PROMOTIONS",
    "CATEGORY_UPDATES",
    "CATEGORY_FORUMS",
  ]);
  return sys.has(label.toUpperCase());
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

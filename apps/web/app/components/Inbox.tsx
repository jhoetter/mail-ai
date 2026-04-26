import { PageHeader, Button } from "@mailai/ui";
import { Inbox as InboxIcon, Paperclip, Pencil, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { PageShell } from "./PageShell";
import { EmptyView } from "./EmptyView";
import { listThreads, type ThreadSummary, type TagSummary } from "../lib/threads-client";
import { useTranslator } from "../lib/i18n/useTranslator";
import { useChrome } from "../lib/shell/ChromeContext";
import { useRegisterPaletteCommands } from "../lib/shell/paletteRegistry";
import { useMailHostChrome } from "../lib/shell/hostChrome";
import { dispatchCommand } from "../lib/commands-client";
import { ReadOnlyChips } from "./TagChips";
import { useActiveView } from "./ViewTabs";
import { listViewThreads, listViews, type ViewSummary } from "../lib/views-client";
import { syncAccount, type AccountSummary } from "../lib/oauth-client";
import { getCachedAccounts, loadAccountsCached } from "../lib/accounts-cache";
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

type AccountsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; rows: AccountSummary[] };

// Inbox is the canonical entry surface. apps/web mounts it directly;
// hofOS stages the same component into the native mailai module, so
// there is no copy/paste drift.
//
// Reads from /api/threads (the OAuth REST sync drops messages there
// during onboarding + on every "Sync now"). When that's empty we
// surface a real onboarding state instead of demo data — getting an
// inbox of "Welcome to mail-ai" / "Q3 numbers" right after connecting
// a real Gmail was the dishonest thing the previous version did.
export function Inbox() {
  const { t } = useTranslator();
  const chrome = useChrome();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ThreadRow | null>(null);
  const [composing, setComposing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const { viewId } = useActiveView();
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [accounts, setAccounts] = useState<AccountsState>(() => {
    const cached = getCachedAccounts();
    return cached ? { status: "ok", rows: cached } : { status: "loading" };
  });
  const hostThreadId = useMailHostThreadId();
  const attemptedInitialSync = useRef<Set<string>>(new Set());

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
    if (!getCachedAccounts()) setAccounts({ status: "loading" });
    loadAccountsCached({ force: true })
      .then((rows) => {
        if (!cancelled) setAccounts({ status: "ok", rows });
      })
      .catch((err) => {
        if (!cancelled) {
          setAccounts({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (accounts.status !== "ok" || accounts.rows.length === 0) return;
    const pending = accounts.rows.filter(
      (account) => account.status === "ok" && !attemptedInitialSync.current.has(account.id),
    );
    if (pending.length === 0) return;
    for (const account of pending) {
      attemptedInitialSync.current.add(account.id);
    }
    void Promise.allSettled(
      pending.map((account) => syncAccount(account.id, { folders: ["inbox"] })),
    ).then(refresh);
  }, [accounts, refresh]);

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

  const headerActions = useMemo(
    () => (
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
    ),
    [refresh, t],
  );

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
  const emptyKind = resolveEmptyKind(viewId, views);
  const syncError = accounts.status === "ok" ? firstSyncError(accounts.rows) : null;
  const hasAccounts = accounts.status === "ok" && accounts.rows.length > 0;
  const hasLoadedEmptyRows = threads !== null && rows.length === 0;

  useEffect(() => {
    if (rows.length === 0) {
      if (selected) setSelected(null);
      return;
    }

    if (hostThreadId) {
      const match = rows.find((row) => row.id === hostThreadId);
      if (match && selected?.id !== match.id) setSelected(match);
      return;
    }

    if (!selected || !rows.some((row) => row.id === selected.id)) {
      const first = rows[0];
      if (!first) return;
      setSelected(first);
      writeMailThreadPath(first.id, true);
    }
  }, [hostThreadId, rows, selected]);

  useMailHostChrome({
    title: selected?.subject || t("inbox.title"),
    breadcrumbs: selected
      ? [
          { label: "Mail", href: "/mail/inbox" },
          { label: t("inbox.title"), href: "/mail/inbox" },
        ]
      : [{ label: "Mail" }],
    actions: headerActions,
    actionsSyncKey: `inbox:${selected?.id ?? "list"}:${refreshTick}`,
  });

  const onToggleStar = useCallback((row: ThreadRow) => {
    const next = !row.starred;
    // Optimistic patch
    setThreads((prev) =>
      prev ? prev.map((tr) => (tr.id === row.id ? { ...tr, starred: next } : tr)) : prev,
    );
    void dispatchCommand({
      type: "mail:star",
      payload: { providerMessageId: row.providerMessageId, starred: next },
    }).catch(() => {
      setThreads((prev) =>
        prev ? prev.map((tr) => (tr.id === row.id ? { ...tr, starred: !next } : tr)) : prev,
      );
    });
  }, []);

  return (
    <PageShell>
      {chrome === "full" ? <PageHeader title={t("inbox.title")} actions={headerActions} /> : null}
      {/*
        Two-pane layout on desktop (≥ md), single-pane on phones/tablets.
        On mobile the list and the thread are mutually exclusive: tapping
        a row swaps the visible pane. The detail pane gets a back button
        in its header (rendered inside ThreadView) to come back to the
        list. We toggle visibility with Tailwind utilities rather than
        unmounting so the list scroll position is preserved when going
        back into a thread.
      */}
      <div
        className={
          "flex min-h-0 flex-1 md:grid " +
          (hasLoadedEmptyRows ? "md:grid-cols-1" : "md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]")
        }
      >
        <section
          className={
            "flex min-h-0 flex-1 flex-col overflow-hidden border-divider bg-background md:flex-initial md:border-r " +
            (hasLoadedEmptyRows ? "md:border-r-0" : "") +
            (selected ? " hidden md:flex" : " flex")
          }
        >
          <div
            className={
              "min-h-0 flex-1 overflow-y-auto " +
              (hasLoadedEmptyRows ? "flex items-center justify-center" : "")
            }
          >
            {loadError ? (
              <p className="px-4 py-3 text-sm text-error">
                {t("inbox.loadError", { error: loadError })}
              </p>
            ) : threads === null ? (
              <p className="px-4 py-3 text-sm text-secondary">{t("inbox.loading")}</p>
            ) : rows.length === 0 ? (
              <div className="px-4 py-3">
                {accounts.status === "loading" ? (
                  <p className="text-sm text-secondary">{t("common.loading")}</p>
                ) : accounts.status === "error" ? (
                  <p className="text-sm text-error">
                    {t("inbox.loadError", { error: accounts.error })}
                  </p>
                ) : (
                  <EmptyView kind={emptyKind} hasAccounts={hasAccounts} lastSyncError={syncError} />
                )}
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
                      onClick={() => {
                        setSelected(r);
                        writeMailThreadPath(r.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(r);
                          writeMailThreadPath(r.id);
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
                        <Star size={13} aria-hidden fill={r.starred ? "currentColor" : "none"} />
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
                              <Paperclip size={11} aria-hidden className="text-tertiary" />
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
                        <span className="truncate text-xs text-tertiary">{r.snippet}</span>
                        {r.tags.length > 0 || r.labels.length > 0 ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {r.tags.length > 0 ? <ReadOnlyChips tags={r.tags} compact /> : null}
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
            (selected ? "flex" : rows.length > 0 ? "hidden md:flex" : "hidden")
          }
        >
          {selected ? (
            <ThreadView
              threadId={selected.id}
              subject={selected.subject}
              onBack={() => {
                setSelected(null);
                writeMailInboxPath();
              }}
            />
          ) : rows.length > 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <InboxIcon size={28} aria-hidden className="text-tertiary" />
              <p className="text-sm text-tertiary">{t("inbox.selectThread")}</p>
            </div>
          ) : null}
        </section>
      </div>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </PageShell>
  );
}

function useMailHostThreadId(): string | null {
  const [threadId, setThreadId] = useState(readMailHostThreadId);

  useEffect(() => {
    const sync = () => setThreadId(readMailHostThreadId());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return threadId;
}

function readMailHostThreadId(): string | null {
  if (typeof window === "undefined") return null;
  const match = /^\/mail\/inbox\/thread\/([^/?#]+)/.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function writeMailThreadPath(threadId: string, replace = false) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.delete("thread");
  const q = params.toString();
  const next = `/mail/inbox/thread/${encodeURIComponent(threadId)}${q ? `?${q}` : ""}`;
  writeHostPath(next, replace);
}

function writeMailInboxPath() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.delete("thread");
  const q = params.toString();
  writeHostPath(q ? `/mail/inbox?${q}` : "/mail/inbox");
}

function writeHostPath(path: string, replace = false) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === path) return;
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
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

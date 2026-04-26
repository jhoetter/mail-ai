// Workspace top bar — Slack-style global search adapted for mail.
//
// Sits above every route and is the always-visible counterpart to
// the ⌘K command palette: ⌘K is for actions and navigation, this
// bar is for *content discovery* across the six categories the
// product exposes — Nachrichten, Dateien, Personen, Postfächer,
// Tags, Kalender.
//
// Filter chips (parsed inline)
// ----------------------------
//   in:<account-email>   Restrict every domain to one Postfach.
//   from:<email|name>    Restrict messages/files to a sender.
//   to:<email|name>      Restrict messages to a recipient.
//   tag:<name>           Restrict messages to a tag.
//   has:attachment       Only messages that carry an attachment
//                        (alias `has:file`).
//   has:link             Only messages whose body contains a link.
//
// Suggestion chips under the input let users discover the modifier
// syntax without memorising it. The result panel then mirrors the
// same UX pattern as collaboration-ai's TopBar: tabs to filter by
// kind, match-term highlighting, full keyboard navigation, and a
// localStorage-backed recent-search list when the input is empty.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Search, FileText, Mail, User, Mailbox, Calendar } from "lucide-react";
import { apiFetch, baseUrl } from "../lib/api";
import { useTranslator } from "../lib/i18n/useTranslator";

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_MIN_CHARS = 2;
const RECENT_KEY = "mailai.search.recent";
const RECENT_LIMIT = 6;

// ---- API shape (mirrors searchAll in @mailai/overlay-db) -------------

interface MessageHit {
  threadId: string;
  providerThreadId: string;
  subject: string | null;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  date: string;
  hasAttachments: boolean;
  accountId: string;
}

interface FileHit {
  attachmentId: string;
  filename: string | null;
  mime: string;
  sizeBytes: number;
  threadId: string | null;
  messageId: string;
  fromEmail: string | null;
  date: string | null;
}

interface PeopleHit {
  contactId: string;
  displayName: string | null;
  primaryEmail: string;
  lastInteractionAt: string | null;
}

interface MailboxHit {
  accountId: string;
  email: string;
  provider: string;
}

interface TagHit {
  tagId: string;
  name: string;
  color: string;
  threadCount: number;
}

interface CalendarHit {
  eventId: string;
  calendarId: string;
  summary: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
}

interface SearchResult {
  messages: MessageHit[];
  files: FileHit[];
  people: PeopleHit[];
  mailboxes: MailboxHit[];
  tags: TagHit[];
  calendar: CalendarHit[];
}

const EMPTY_RESULT: SearchResult = {
  messages: [],
  files: [],
  people: [],
  mailboxes: [],
  tags: [],
  calendar: [],
};

// ---- Query DSL ---------------------------------------------------------

interface ParsedQuery {
  /** Free-text query forwarded to the server (chips removed). */
  text: string;
  /** Postfach scope (account email or fragment). */
  inAccounts: string[];
  /** Sender filter (email or fragment). */
  from: string[];
  /** Recipient filter (email or fragment). */
  to: string[];
  /** Tag name filter. */
  tag: string[];
  /** True when the user typed `has:attachment` or `has:file`. */
  hasAttachment: boolean;
  /** True when the user typed `has:link`. */
  hasLink: boolean;
}

// We deliberately allow `.` and `@` so `from:user@example.com` parses
// in one go — the original collab-ai regex was channel-flavoured and
// stopped at word boundaries.
const CHIP_REGEX =
  /(?:^|\s)(in:#?[\w.@+-]+|from:@?[\w.@+-]+|to:@?[\w.@+-]+|tag:[\w.+-]+|has:[a-z]+)/gi;

export function parseQuery(raw: string): ParsedQuery {
  const inAccounts: string[] = [];
  const from: string[] = [];
  const to: string[] = [];
  const tag: string[] = [];
  let hasAttachment = false;
  let hasLink = false;
  let text = ` ${raw} `;
  text = text.replace(CHIP_REGEX, (_match, token: string) => {
    const [k, v] = token.split(":");
    if (!k || !v) return " ";
    const key = k.toLowerCase();
    const value = v.replace(/^[#@]/, "").toLowerCase();
    switch (key) {
      case "in":
        if (value) inAccounts.push(value);
        break;
      case "from":
        if (value) from.push(value);
        break;
      case "to":
        if (value) to.push(value);
        break;
      case "tag":
        if (value) tag.push(value);
        break;
      case "has":
        if (value === "attachment" || value === "file") hasAttachment = true;
        else if (value === "link") hasLink = true;
        break;
      default:
        break;
    }
    return " ";
  });
  return {
    text: text.trim().replace(/\s+/g, " "),
    inAccounts,
    from,
    to,
    tag,
    hasAttachment,
    hasLink,
  };
}

// Build the query string for `GET /api/search` from a parsed input.
// We pick the first chip value of each kind because the backend
// only supports a single value per filter today — extending to
// multiples means changing the route signature too.
function buildSearchUrl(parsed: ParsedQuery): string | null {
  const sp = new URLSearchParams();
  if (parsed.text.length > 0) sp.set("q", parsed.text);
  if (parsed.inAccounts[0]) sp.set("accountId", parsed.inAccounts[0]);
  if (parsed.from[0]) sp.set("fromEmail", parsed.from[0]);
  if (parsed.to[0]) sp.set("toEmail", parsed.to[0]);
  if (parsed.tag[0]) sp.set("tag", parsed.tag[0]);
  if (parsed.hasAttachment) sp.set("hasAttachment", "1");
  if (parsed.hasLink) sp.set("hasLink", "1");
  if ([...sp.keys()].length === 0) return null;
  return `/api/search?${sp.toString()}`;
}

// ---- Tabs --------------------------------------------------------------

type Tab = "all" | "messages" | "files" | "people" | "mailboxes" | "tags" | "calendar";

const TAB_ORDER: Tab[] = ["all", "messages", "files", "people", "mailboxes", "tags", "calendar"];

interface FlatRow {
  key: string;
  tab: Exclude<Tab, "all">;
  pick: () => void;
  render: (active: boolean) => ReactNode;
}

// ---- Component ---------------------------------------------------------

export function TopBar() {
  const { t } = useTranslator();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Close the dropdown when the user clicks anywhere outside the
  // top-bar container.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const hasChipFilter =
    parsed.inAccounts.length > 0 ||
    parsed.from.length > 0 ||
    parsed.to.length > 0 ||
    parsed.tag.length > 0 ||
    parsed.hasAttachment ||
    parsed.hasLink;

  // Reset the keyboard cursor whenever the result set could change.
  useEffect(() => {
    setActive(0);
  }, [query, tab]);

  // Debounced server search. Cancels any in-flight request when the
  // user keeps typing so the UI never races itself.
  useEffect(() => {
    if (parsed.text.length < SEARCH_MIN_CHARS && !hasChipFilter) {
      setResult(EMPTY_RESULT);
      setError(null);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const url = buildSearchUrl(parsed);
      if (!url) {
        setResult(EMPTY_RESULT);
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      void apiFetch(url, { signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`/api/search ${res.status}`);
          return (await res.json()) as SearchResult;
        })
        .then((data) => {
          setResult(data);
          setError(null);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === "AbortError") return;
          setResult(EMPTY_RESULT);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [parsed.text, hasChipFilter, parsed]);

  // Terms used to highlight matches in result snippets/labels.
  const highlightTerms = useMemo(() => {
    if (parsed.text.length === 0) return [];
    return parsed.text
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }, [parsed.text]);

  // ---- Row open handlers ---------------------------------------------

  const openMessage = useCallback(
    (hit: MessageHit) => {
      // /inbox/thread/:id isn't routed yet — we fall back to the
      // inbox list and surface a warn so anyone debugging knows
      // why the deep link doesn't navigate further. Once the
      // route lands this becomes a thread URL.
      console.warn("[TopBar] thread deep-link not routed; navigating to /inbox", hit.threadId);
      navigate(`/inbox?thread=${encodeURIComponent(hit.threadId)}`);
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [navigate, query],
  );

  const openFile = useCallback(
    (hit: FileHit) => {
      // Attachments live behind a presigned redirect; opening in a
      // new tab matches Gmail/Outlook behaviour and avoids
      // navigating away from the inbox.
      window.open(`${baseUrl()}/api/attachments/${hit.attachmentId}`, "_blank");
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [query],
  );

  const openPerson = useCallback(
    (hit: PeopleHit) => {
      navigate(`/inbox?from=${encodeURIComponent(hit.primaryEmail)}`);
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [navigate, query],
  );

  const openMailbox = useCallback(
    (hit: MailboxHit) => {
      navigate(`/inbox?accountId=${encodeURIComponent(hit.accountId)}`);
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [navigate, query],
  );

  const openTag = useCallback(
    (hit: TagHit) => {
      navigate(`/inbox?tag=${encodeURIComponent(hit.name)}`);
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [navigate, query],
  );

  const openEvent = useCallback(
    (hit: CalendarHit) => {
      navigate(`/calendar?eventId=${encodeURIComponent(hit.eventId)}`);
      setOpen(false);
      setRecents(rememberRecent(query));
    },
    [navigate, query],
  );

  // ---- Flat row list (one source of truth for keyboard + render) -----

  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const m of result.mailboxes) {
      out.push({
        key: `mailbox-${m.accountId}`,
        tab: "mailboxes",
        pick: () => openMailbox(m),
        render: (isActive) => (
          <ResultRow
            active={isActive}
            icon={<Mailbox size={14} />}
            title={highlight(m.email, highlightTerms)}
            hint={m.provider}
          />
        ),
      });
    }
    for (const t of result.tags) {
      out.push({
        key: `tag-${t.tagId}`,
        tab: "tags",
        pick: () => openTag(t),
        render: (isActive) => (
          <ResultRow
            active={isActive}
            icon={
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: t.color }}
              />
            }
            title={highlight(t.name, highlightTerms)}
            hint={`${t.threadCount}`}
          />
        ),
      });
    }
    for (const p of result.people) {
      out.push({
        key: `person-${p.contactId}`,
        tab: "people",
        pick: () => openPerson(p),
        render: (isActive) => (
          <ResultRow
            active={isActive}
            icon={<User size={14} />}
            title={highlight(p.displayName ?? p.primaryEmail, highlightTerms)}
            {...(p.displayName ? { hint: p.primaryEmail } : {})}
          />
        ),
      });
    }
    for (const f of result.files) {
      out.push({
        key: `file-${f.attachmentId}`,
        tab: "files",
        pick: () => openFile(f),
        render: (isActive) => (
          <ResultRow
            active={isActive}
            icon={<FileText size={14} />}
            title={highlight(f.filename ?? "(unnamed)", highlightTerms)}
            hint={`${formatBytes(f.sizeBytes)} · ${f.fromEmail ?? ""}`.trim()}
          />
        ),
      });
    }
    for (const m of result.messages) {
      out.push({
        key: `msg-${m.threadId}`,
        tab: "messages",
        pick: () => openMessage(m),
        render: (isActive) => (
          <MessageRowView
            active={isActive}
            subject={m.subject ?? "(no subject)"}
            snippet={m.snippet}
            sender={m.fromName ?? m.fromEmail ?? ""}
            date={m.date ? formatRelative(new Date(m.date).getTime()) : ""}
            terms={highlightTerms}
          />
        ),
      });
    }
    for (const e of result.calendar) {
      out.push({
        key: `event-${e.eventId}`,
        tab: "calendar",
        pick: () => openEvent(e),
        render: (isActive) => (
          <ResultRow
            active={isActive}
            icon={<Calendar size={14} />}
            title={highlight(e.summary ?? "(untitled)", highlightTerms)}
            hint={[e.location ?? "", new Date(e.startsAt).toLocaleString()]
              .filter(Boolean)
              .join(" · ")}
          />
        ),
      });
    }
    return out;
  }, [result, highlightTerms, openMailbox, openTag, openPerson, openFile, openMessage, openEvent]);

  // Apply the active tab filter on top of the flat list.
  const visibleRows = useMemo(() => {
    if (tab === "all") return rows;
    return rows.filter((r) => r.tab === tab);
  }, [rows, tab]);

  // Scroll the active row into view as the user keyboard-navigates.
  useEffect(() => {
    const node = rowRefs.current[active];
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pickFirst() {
    const target = visibleRows[active] ?? visibleRows[0];
    if (target) target.pick();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query.length > 0) {
        setQuery("");
      } else if (open) {
        setOpen(false);
        inputRef.current?.blur();
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(visibleRows.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Tab" && visibleRows.length > 0) {
      e.preventDefault();
      const idx = TAB_ORDER.indexOf(tab);
      const next = e.shiftKey
        ? (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length
        : (idx + 1) % TAB_ORDER.length;
      setTab(TAB_ORDER[next] ?? "all");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pickFirst();
    }
  }

  const tabCounts = useMemo<Record<Tab, number>>(
    () => ({
      all: rows.length,
      messages: rows.filter((r) => r.tab === "messages").length,
      files: rows.filter((r) => r.tab === "files").length,
      people: rows.filter((r) => r.tab === "people").length,
      mailboxes: rows.filter((r) => r.tab === "mailboxes").length,
      tags: rows.filter((r) => r.tab === "tags").length,
      calendar: rows.filter((r) => r.tab === "calendar").length,
    }),
    [rows],
  );

  const showEmptyState = query.length === 0;
  const showNoMatches = !showEmptyState && visibleRows.length === 0 && error === null;

  // Reset row refs each render so we can re-collect them in order.
  rowRefs.current = [];

  return (
    <div
      ref={containerRef}
      className="relative z-30 flex h-11 shrink-0 items-center gap-2 border-b border-divider bg-surface px-3"
    >
      <div className="relative mx-auto w-full md:max-w-2xl">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary">
          <Search size={14} />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t("topbar.placeholder")}
          aria-label={t("topbar.placeholder")}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="topbar-search-listbox"
          aria-activedescendant={
            visibleRows[active] ? `topbar-row-${visibleRows[active].key}` : undefined
          }
          className="h-7 w-full rounded-md border border-divider bg-background pl-8 pr-12 text-sm text-foreground transition-colors placeholder:text-tertiary focus:outline-none focus:ring-2 focus:ring-foreground/20"
          data-testid="topbar-search"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 text-[10px] text-tertiary sm:flex">
          <Kbd>⌘</Kbd>
          <Kbd>F</Kbd>
        </span>
      </div>
      {open && (
        <div
          id="topbar-search-listbox"
          role="listbox"
          className="absolute left-1/2 top-full z-40 mt-1 flex max-h-[80dvh] w-[min(48rem,calc(100vw-1rem))] -translate-x-1/2 flex-col overflow-hidden rounded-md border border-divider bg-surface shadow-2xl"
        >
          <Tabs tab={tab} counts={tabCounts} onChange={setTab} t={t} />
          <ChipSuggestions
            parsed={parsed}
            onAppend={(chip) => {
              setQuery((q) =>
                q.endsWith(" ") || q.length === 0 ? `${q}${chip} ` : `${q} ${chip} `,
              );
              inputRef.current?.focus();
            }}
            t={t}
          />
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
            {showEmptyState && recents.length > 0 && (
              <Group label={t("topbar.recentSearches")}>
                {recents.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setQuery(r);
                      inputRef.current?.focus();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-hover"
                  >
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-tertiary">
                      <Search size={12} />
                    </span>
                    <span className="truncate">{r}</span>
                  </button>
                ))}
              </Group>
            )}
            {showEmptyState && recents.length === 0 && (
              <div className="px-3 py-4 text-xs text-tertiary">{t("topbar.hint")}</div>
            )}
            {error && (
              <div className="px-3 py-4 text-sm text-error">{t("topbar.error", { error })}</div>
            )}
            {showNoMatches && (
              <div className="px-3 py-4 text-sm text-tertiary">{t("topbar.empty")}</div>
            )}
            {!showEmptyState && visibleRows.length > 0 && (
              <div>
                {visibleRows.map((row, idx) => (
                  <div
                    key={row.key}
                    id={`topbar-row-${row.key}`}
                    role="option"
                    aria-selected={active === idx}
                    ref={(el) => {
                      rowRefs.current[idx] = el;
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActive(idx);
                        row.pick();
                      }}
                      onMouseEnter={() => setActive(idx)}
                      className="block w-full text-left"
                    >
                      {row.render(active === idx)}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <FooterHint t={t} />
        </div>
      )}
    </div>
  );
}

// ---- Subcomponents -----------------------------------------------------

function Tabs({
  tab,
  counts,
  onChange,
  t,
}: {
  tab: Tab;
  counts: Record<Tab, number>;
  onChange: (next: Tab) => void;
  t: ReturnType<typeof useTranslator>["t"];
}) {
  const labels: Record<Tab, string> = {
    all: t("topbar.tabs.all"),
    messages: t("topbar.tabs.messages"),
    files: t("topbar.tabs.files"),
    people: t("topbar.tabs.people"),
    mailboxes: t("topbar.tabs.mailboxes"),
    tags: t("topbar.tabs.tags"),
    calendar: t("topbar.tabs.calendar"),
  };
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-divider px-2 py-1.5">
      {TAB_ORDER.map((id) => {
        const isActive = id === tab;
        const count = counts[id];
        return (
          <button
            key={id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(id)}
            className={
              "flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors " +
              (isActive
                ? "bg-hover font-medium text-foreground"
                : "text-secondary hover:bg-hover hover:text-foreground")
            }
          >
            <span>{labels[id]}</span>
            {count > 0 && (
              <span
                className={
                  "rounded px-1 text-[10px] tabular-nums " +
                  (isActive ? "text-foreground" : "text-tertiary")
                }
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ChipSuggestions({
  parsed,
  onAppend,
  t,
}: {
  parsed: ParsedQuery;
  onAppend: (chip: string) => void;
  t: ReturnType<typeof useTranslator>["t"];
}) {
  // We don't yet have a current-mailbox affordance, so the
  // suggestion row is the static set: has:attachment, has:link.
  // (Per-tag suggestions could come later from the result.tags
  // payload, but the chip needs the literal `tag:<name>` text.)
  const chips: Array<{ id: string; label: string; chip: string; show: boolean }> = [
    {
      id: "has-attachment",
      label: t("topbar.chips.hasAttachment"),
      chip: "has:attachment",
      show: !parsed.hasAttachment,
    },
    {
      id: "has-link",
      label: t("topbar.chips.hasLink"),
      chip: "has:link",
      show: !parsed.hasLink,
    },
  ].filter((c) => c.show);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-divider px-2 py-1.5">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAppend(c.chip)}
          className="rounded-full border border-divider bg-background px-2 py-0.5 text-[11px] text-secondary transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function FooterHint({ t }: { t: ReturnType<typeof useTranslator>["t"] }) {
  return (
    <div className="flex items-center gap-3 border-t border-divider px-3 py-1.5 text-[10px] text-tertiary">
      <span className="flex items-center gap-1">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span>{t("topbar.footer.navigate")}</span>
      </span>
      <span className="flex items-center gap-1">
        <Kbd>↵</Kbd>
        <span>{t("topbar.footer.open")}</span>
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Esc</Kbd>
        <span>{t("topbar.footer.close")}</span>
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Kbd>⌘</Kbd>
        <Kbd>F</Kbd>
        <span>{t("topbar.footer.focus")}</span>
      </span>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-tertiary">{label}</p>
      {children}
    </div>
  );
}

function ResultRow({
  active,
  icon,
  title,
  hint,
}: {
  active: boolean;
  icon: ReactNode;
  title: ReactNode;
  hint?: string;
}) {
  return (
    <div
      className={
        "flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors " +
        (active ? "bg-hover text-foreground" : "text-foreground")
      }
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-tertiary">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        {hint && <span className="truncate text-xs text-tertiary">{hint}</span>}
      </span>
    </div>
  );
}

function MessageRowView({
  active,
  subject,
  snippet,
  sender,
  date,
  terms,
}: {
  active: boolean;
  subject: string;
  snippet: string;
  sender: string;
  date: string;
  terms: string[];
}) {
  return (
    <div
      className={
        "flex w-full items-start gap-2 px-3 py-2 text-sm transition-colors " +
        (active ? "bg-hover text-foreground" : "text-foreground")
      }
    >
      <span className="mt-0.5 flex-shrink-0 text-tertiary">
        <Mail size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-xs text-tertiary">
          <span className="truncate font-medium text-secondary">{sender}</span>
          {date && <span>· {date}</span>}
        </span>
        <span className="truncate font-medium">{highlight(subject, terms)}</span>
        <span className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-tertiary">
          {highlight(snippet, terms)}
        </span>
      </span>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-divider bg-background px-1 text-[10px] font-medium leading-none text-secondary">
      {children}
    </kbd>
  );
}

// ---- Helpers -----------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatRelative(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Wrap each occurrence of any term in `<mark>` so the user can scan
 * results faster. Case-insensitive, longest-term-first to avoid
 * shorter terms eating substrings of longer ones.
 */
export function highlight(text: string, terms: string[]): ReactNode {
  if (text.length === 0 || terms.length === 0) return text;
  const safe = terms
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (safe.length === 0) return text;
  const re = new RegExp(`(${safe.join("|")})`, "gi");
  const parts = text.split(re);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      return (
        <mark key={idx} className="rounded-sm bg-foreground/10 px-0.5 text-foreground">
          {part}
        </mark>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

export function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecent(query: string): string[] {
  const trimmed = query.trim();
  if (typeof window === "undefined" || trimmed.length === 0) return loadRecents();
  try {
    const current = loadRecents();
    const next = [trimmed, ...current.filter((x) => x !== trimmed)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadRecents();
  }
}

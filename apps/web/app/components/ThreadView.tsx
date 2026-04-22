"use client";

// Reader for one thread. Renders a Gmail/Outlook-style conversation:
// the latest message is expanded by default, every previous message
// collapses to a one-line summary you can click to open. Each message
// shows a sanitized body (preferring text/html when the provider
// has one) inside an isolated <iframe srcdoc> so foreign CSS / script
// can never bleed into our app shell.
//
// Reply lives at the bottom of the thread (not in a modal) — see
// InlineReply. The thread layout fills the available column height
// and adds a subtle gradient mask under the sticky reply bar so the
// scroll boundary stays visible without being noisy.
//
// We never trust raw HTML straight from Gmail/Graph: it goes through
// DOMPurify with a tight allow-list before we ever hand it to the
// iframe, and the iframe itself is sandboxed (no scripts, no
// same-origin) as a defence-in-depth.

import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { getThread, type ThreadDetail, type ThreadMessage } from "../lib/threads-client";
import { InlineReply } from "./InlineReply";
import { TagChips } from "./TagChips";
import { ThreadActions } from "./ThreadActions";
import { useTranslator } from "../lib/i18n/useTranslator";
import { useRegisterPaletteCommands } from "../lib/shell";
import { dispatchCommand } from "../lib/commands-client";

interface Props {
  threadId: string;
  subject: string;
  // Bumped by the parent to force a re-fetch (e.g. after a reply
  // lands so the user sees their own message in the conversation).
  refreshKey?: number;
}

export function ThreadView({ threadId, subject, refreshKey }: Props) {
  const { t } = useTranslator();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [replyTick, setReplyTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getThread(threadId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, refreshKey, localRefresh]);

  const headerCount = detail
    ? t(detail.messages.length === 1 ? "thread.messageCountOne" : "thread.messageCount", {
        count: detail.messages.length,
      }) + (detail.unreadCount > 0 ? ` · ${detail.unreadCount} unread` : "")
    : threadId;

  // Register Reply / Snooze / Done in the palette while a thread is
  // open. Reply now opens the inline pane (no modal); Snooze/Done
  // dispatch directly.
  const threadCommands = useMemo(
    () => [
      {
        id: "thread-reply",
        label: t("commands.thread-reply.label"),
        hint: t("commands.thread-reply.description"),
        section: t("palette.groupThread"),
        shortcut: "r",
        run: () => setReplyTick((n) => n + 1),
      },
      {
        id: "thread-snooze",
        label: t("commands.thread-snooze.label"),
        hint: t("commands.thread-snooze.description"),
        section: t("palette.groupThread"),
        shortcut: "s",
        enabled: !!detail,
        run: () => {
          if (!detail) return;
          void dispatchCommand({
            type: "thread:snooze",
            payload: {
              providerThreadId: detail.providerThreadId,
              until: "tomorrow",
            },
          }).then(() => setLocalRefresh((n) => n + 1));
        },
      },
      {
        id: "thread-done",
        label: t("commands.thread-done.label"),
        hint: t("commands.thread-done.description"),
        section: t("palette.groupThread"),
        shortcut: "e",
        enabled: !!detail,
        run: () => {
          if (!detail) return;
          void dispatchCommand({
            type: "thread:mark-done",
            payload: { providerThreadId: detail.providerThreadId },
          }).then(() => setLocalRefresh((n) => n + 1));
        },
      },
    ],
    [t, detail],
  );
  useRegisterPaletteCommands(threadCommands);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-divider pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-foreground">
            {detail?.subject ?? subject}
          </h2>
          <p className="mt-1 text-xs text-secondary">{headerCount}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {detail ? (
            <ThreadActions
              providerThreadId={detail.providerThreadId}
              onChanged={() => setLocalRefresh((n) => n + 1)}
            />
          ) : null}
        </div>
      </header>

      <div className="pt-3">
        <TagChips threadId={threadId} />
      </div>

      <div className="-mx-1 mt-3 flex-1 min-h-0 overflow-y-auto px-1">
        {error ? (
          <p className="text-sm text-error">{t("thread.loadError", { error })}</p>
        ) : detail === null ? (
          <p className="text-sm text-secondary">{t("thread.loading")}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {detail.messages.map((m, i) => (
              <li key={m.id}>
                <MessageCard
                  message={m}
                  // Latest message expanded by default; older messages
                  // collapse to a single-line preview the user can click
                  // to expand — same shape Gmail/Outlook use.
                  defaultExpanded={i === detail.messages.length - 1}
                />
              </li>
            ))}
          </ol>
        )}

        {detail ? (
          <InlineReply
            thread={detail}
            autoExpandKey={replyTick}
            onSent={() => {
              // Re-fetch so the new message lands in the thread
              // without a page reload; the next sync pass will turn
              // it into a real oauth_messages row, but until then the
              // user at least sees the thread refresh trigger and any
              // concurrent updates.
              setLocalRefresh((n) => n + 1);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

interface MessageCardProps {
  message: ThreadMessage;
  defaultExpanded: boolean;
}

function MessageCard({ message, defaultExpanded }: MessageCardProps) {
  const { t } = useTranslator();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);

  const senderName = message.fromName ?? message.fromEmail ?? message.from;

  return (
    <article
      className={
        "rounded-lg border border-divider bg-surface text-sm transition-colors " +
        (message.unread ? "ring-1 ring-accent/40" : "")
      }
    >
      <header
        className="flex items-start gap-3 px-4 py-3"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <Avatar name={senderName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span className={message.unread ? "font-semibold" : "font-medium"}>
                {senderName}
              </span>
              {message.fromEmail && message.fromName ? (
                <span className="ml-1.5 text-xs text-tertiary">
                  &lt;{message.fromEmail}&gt;
                </span>
              ) : null}
            </div>
            <time
              dateTime={message.date}
              title={formatExact(message.date)}
              className="shrink-0 text-xs text-secondary"
            >
              {formatRelativeOrShort(message.date)}
            </time>
          </div>
          {expanded ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowDetails((v) => !v);
              }}
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-secondary hover:text-foreground"
            >
              <span>{message.to ? `${t("thread.to").toLowerCase()} ${message.to}` : ""}</span>
              <span aria-hidden className="text-tertiary">
                ·
              </span>
              <span className="underline-offset-2 hover:underline">
                {showDetails ? t("thread.hideDetails") : t("thread.details")}
              </span>
            </button>
          ) : (
            <div className="truncate text-xs text-secondary">{message.snippet}</div>
          )}
          {expanded && showDetails ? (
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs text-secondary">
              <dt className="text-tertiary">{t("thread.from")}</dt>
              <dd className="truncate">
                {senderName}
                {message.fromEmail ? ` <${message.fromEmail}>` : ""}
              </dd>
              {message.to ? (
                <>
                  <dt className="text-tertiary">{t("thread.to")}</dt>
                  <dd className="truncate">{message.to}</dd>
                </>
              ) : null}
              <dt className="text-tertiary">date</dt>
              <dd>{formatExact(message.date)}</dd>
            </dl>
          ) : null}
        </div>
      </header>
      {expanded ? (
        <div className="border-t border-divider px-4 py-4">
          <MessageBody message={message} />
        </div>
      ) : null}
    </article>
  );
}

function MessageBody({ message }: { message: ThreadMessage }) {
  const { t } = useTranslator();
  // Prefer HTML when the provider gave us one — that's what the
  // sender saw. Fall back to text/plain (rendered as pre-wrap so
  // hard wraps and indentation survive) and finally to the snippet
  // when the body fetch hasn't completed yet.
  if (message.bodyHtml && message.bodyHtml.trim().length > 0) {
    return <HtmlBody html={message.bodyHtml} />;
  }
  if (message.bodyText && message.bodyText.trim().length > 0) {
    return <TextBody text={message.bodyText} />;
  }
  if (message.bodyFetchedAt === null) {
    return <p className="text-xs text-secondary">{t("thread.fetchingBody")}</p>;
  }
  return (
    <p className="whitespace-pre-wrap text-foreground/90">{message.snippet || t("thread.noBody")}</p>
  );
}

// Plain-text body. Detect a quoted-reply tail ("On X wrote:" or a run
// of leading-">"-prefixed lines) and hide it behind a toggle, the
// same way Gmail does — keeps the conversation scannable when people
// top-post on long threads.
function TextBody({ text }: { text: string }) {
  const { t } = useTranslator();
  const [showQuoted, setShowQuoted] = useState(false);
  const { head, quoted } = useMemo(() => splitQuoted(text), [text]);
  return (
    <div className="prose-mailai whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
      {head}
      {quoted ? (
        <>
          {showQuoted ? (
            <div className="mt-3 border-l-2 border-divider pl-3 text-secondary">{quoted}</div>
          ) : null}
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            className="mt-2 inline-flex h-5 w-5 items-center justify-center rounded border border-divider bg-background text-tertiary hover:text-foreground"
            title={showQuoted ? t("thread.hideQuoted") : t("thread.showQuoted")}
            aria-label={showQuoted ? t("thread.hideQuoted") : t("thread.showQuoted")}
          >
            …
          </button>
        </>
      ) : null}
    </div>
  );
}

function splitQuoted(text: string): { head: string; quoted: string | null } {
  const lines = text.split(/\r?\n/);
  // Find the first quote marker — either "On <date>, X wrote:" or
  // the start of a contiguous run of ">"-prefixed lines.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^On .+ wrote:\s*$/i.test(line) || /^Am .+ schrieb .+:\s*$/i.test(line)) {
      const head = lines.slice(0, i).join("\n").replace(/\n+$/, "");
      const quoted = lines.slice(i).join("\n");
      if (head.trim().length === 0) return { head: text, quoted: null };
      return { head, quoted };
    }
    if (/^>/.test(line)) {
      // Walk back to the last non-blank line so the "On X wrote:"
      // intro stays with the quoted block when present.
      let cut = i;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j] ?? "";
        if (prev.trim().length === 0) {
          cut = j;
          continue;
        }
        if (/wrote:\s*$|schrieb .+:\s*$/i.test(prev)) cut = j;
        break;
      }
      const head = lines.slice(0, cut).join("\n").replace(/\n+$/, "");
      const quoted = lines.slice(cut).join("\n");
      if (head.trim().length === 0) return { head: text, quoted: null };
      return { head, quoted };
    }
  }
  return { head: text, quoted: null };
}

// Render sanitized HTML in an isolated, sandboxed iframe with an
// auto-grown height. Doing it through srcdoc means the iframe gets a
// blank origin, so even if our DOMPurify sweep misses something, the
// untrusted markup can't reach our cookies, our window, or our CSS.
function HtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(120);
  // DOMPurify reaches for `window` so we only sanitize after mount.
  // Rendering nothing on the server is fine: the iframe is a leaf
  // component and its parent already shows the message header.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const safe = useMemo(() => (mounted ? sanitizeEmailHtml(html) : ""), [html, mounted]);
  const doc = useMemo(() => buildIframeDoc(safe), [safe]);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const sync = () => {
      try {
        const h = el.contentDocument?.documentElement?.scrollHeight ?? 0;
        if (h > 0) setHeight(Math.min(h + 4, 4000));
      } catch {
        // Cross-origin (shouldn't happen with srcdoc) — leave as is.
      }
    };
    el.addEventListener("load", sync);
    // Re-measure twice because images / fonts can land late and
    // change layout after the initial load fires.
    const t1 = setTimeout(sync, 200);
    const t2 = setTimeout(sync, 1200);
    return () => {
      el.removeEventListener("load", sync);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [doc]);

  return (
    <iframe
      ref={iframeRef}
      title="message body"
      // sandbox without `allow-scripts` blocks every script, every
      // form submit, and every plugin. We allow `allow-popups` only
      // so target=_blank links can open in a new tab when the user
      // clicks them.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{ width: "100%", height, border: "0" }}
    />
  );
}

function buildIframeDoc(sanitizedBody: string): string {
  // Inline a minimal style reset so the rendered email picks up
  // sensible defaults regardless of what the sender's HTML brings.
  // Pull the live theme tokens from the parent so the rendered mail
  // matches the surrounding chrome (white-on-light vs. soft-on-dark).
  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const fg = isDark ? "#e3e2e0" : "#37352f";
  const muted = isDark ? "#9b9a97" : "#787774";
  const link = isDark ? "#60a5fa" : "#2563eb";
  const quote = isDark ? "#5a5a58" : "#d6d6d4";
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<base target="_blank" />
<style>
  html,body { margin:0; padding:0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         font-size: 15px; line-height: 1.6; color: ${fg}; word-wrap: break-word; }
  a { color: ${link}; }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 2px solid ${quote}; margin: 0 0 8px 0; padding: 0 0 0 12px; color: ${muted}; }
  pre, code { white-space: pre-wrap; word-wrap: break-word; }
  table { max-width: 100%; }
</style>
</head><body>${sanitizedBody}</body></html>`;
}

function sanitizeEmailHtml(html: string): string {
  // Strip everything dangerous: scripts, event handlers, javascript:
  // URLs, <object>/<embed>/<iframe>, etc. Keep the structural tags
  // emails actually use. We keep style attributes because most HTML
  // emails rely on inline styles for layout, but DOMPurify still
  // strips `expression()` and url(javascript:…) from them.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover", "onfocus"],
    ALLOW_DATA_ATTR: false,
  });
}

function Avatar({ name }: { name: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  // Stable per-name hue so different senders get distinct chips
  // without a noisy palette.
  const hue = nameHue(name);
  const bg = `hsl(${hue}deg 65% 88%)`;
  const fg = `hsl(${hue}deg 55% 28%)`;
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{ background: bg, color: fg }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function formatRelativeOrShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`;
  if (diffMs < 7 * day) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatExact(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

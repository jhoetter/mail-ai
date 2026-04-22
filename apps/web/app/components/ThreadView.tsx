"use client";

// Reader for one thread. Renders a Gmail/Outlook-style conversation:
// the latest message is expanded by default, every previous message
// collapses to a one-line summary you can click to open. Each message
// shows a sanitized body (preferring text/html when the provider
// has one) inside an isolated <iframe srcdoc> so foreign CSS / script
// can never bleed into our app shell.
//
// We never trust raw HTML straight from Gmail/Graph: it goes through
// DOMPurify with a tight allow-list before we ever hand it to the
// iframe, and the iframe itself is sandboxed (no scripts, no
// same-origin) as a defence-in-depth.

import { Button } from "@mailai/ui";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { getThread, type ThreadDetail, type ThreadMessage } from "../lib/threads-client";
import { Composer } from "./Composer";

interface Props {
  threadId: string;
  subject: string;
  // Bumped by the parent to force a re-fetch (e.g. after a reply
  // lands so the user sees their own message in the conversation).
  refreshKey?: number;
}

export function ThreadView({ threadId, subject, refreshKey }: Props) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);

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
    ? `${detail.messages.length} message${detail.messages.length === 1 ? "" : "s"}` +
      (detail.unreadCount > 0 ? ` · ${detail.unreadCount} unread` : "")
    : threadId;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold truncate">{detail?.subject ?? subject}</h2>
          <p className="text-xs text-muted mt-1">{headerCount}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="primary" onClick={() => setComposeOpen(true)}>
            Reply
          </Button>
          <Button size="sm" variant="secondary" disabled>
            Assign
          </Button>
          <Button size="sm" variant="secondary" disabled>
            Resolve
          </Button>
        </div>
      </header>

      {error ? (
        <p className="text-sm text-danger">Couldn&apos;t load thread: {error}</p>
      ) : detail === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-2">
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

      <Composer
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyTo={detail ? { threadId: detail.id, subject: detail.subject } : { threadId, subject }}
        onSent={() => {
          setComposeOpen(false);
          // Re-fetch so the new message lands in the thread without a
          // page reload; the next sync pass will turn it into a real
          // oauth_messages row, but until then the user at least sees
          // the thread refresh trigger and any concurrent updates.
          setLocalRefresh((n) => n + 1);
        }}
      />
    </div>
  );
}

interface MessageCardProps {
  message: ThreadMessage;
  defaultExpanded: boolean;
}

function MessageCard({ message, defaultExpanded }: MessageCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <article
      className={
        "rounded-md border border-border bg-surface text-sm transition-colors " +
        (message.unread ? "border-l-2 border-l-accent" : "")
      }
    >
      <button
        type="button"
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-bg/40"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Avatar name={message.fromName ?? message.fromEmail ?? message.from} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={message.unread ? "font-semibold" : "font-medium"}>
              {message.fromName ?? message.fromEmail ?? message.from}
            </span>
            <span className="shrink-0 text-xs text-muted">{formatLong(message.date)}</span>
          </div>
          <div className="text-xs text-muted truncate">
            {expanded ? (message.to ? `to ${message.to}` : "") : message.snippet}
          </div>
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-border px-3 py-3">
          <MessageBody message={message} />
        </div>
      ) : null}
    </article>
  );
}

function MessageBody({ message }: { message: ThreadMessage }) {
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
    return <p className="text-xs text-muted">Loading message body…</p>;
  }
  return (
    <p className="whitespace-pre-wrap text-fg/90">{message.snippet || "(no content)"}</p>
  );
}

function TextBody({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-fg">
      {text}
    </pre>
  );
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
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<base target="_blank" />
<style>
  html,body { margin:0; padding:0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         font-size: 14px; line-height: 1.5; color: #e5e7eb; word-wrap: break-word; }
  a { color: #60a5fa; }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 2px solid #374151; margin: 0 0 8px 0; padding: 0 0 0 12px; color: #9ca3af; }
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
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg text-xs font-medium text-fg border border-border">
      {initial}
    </span>
  );
}

function formatLong(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

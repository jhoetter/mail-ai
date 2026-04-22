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
import {
  ArrowLeft,
  Download,
  File,
  FileImage,
  FileText,
  ImageOff,
  Paperclip,
  ScrollText,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { baseUrl } from "../lib/api";
import {
  getThread,
  type ThreadAttachment,
  type ThreadDetail,
  type ThreadMessage,
} from "../lib/threads-client";
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
  // Mobile-only "back to list" handler. The Inbox passes this so the
  // detail pane (which is full-screen on phones) can hand control
  // back to the list. On desktop the back button is hidden via
  // Tailwind, so passing or omitting this changes nothing visually.
  onBack?: () => void;
}

export function ThreadView({ threadId, subject, refreshKey, onBack }: Props) {
  const { t } = useTranslator();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [replyTick, setReplyTick] = useState(0);
  const [forwardMessage, setForwardMessage] = useState<ThreadMessage | null>(null);
  const [forwardTick, setForwardTick] = useState(0);
  const [showOriginal, setShowOriginal] = useState<ThreadMessage | null>(null);
  // Per-thread session decision to allow remote (non-cid) images.
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setAllowRemoteImages(false);
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

  // Mark-read on open (debounced). We dispatch once per open of an
  // unread thread; the debounce prevents marking-read on accidental
  // keyboard navigation through the inbox.
  useEffect(() => {
    if (!detail) return;
    if (detail.unreadCount === 0) return;
    const handle = setTimeout(() => {
      void dispatchCommand({
        type: "mail:mark-read",
        payload: { providerThreadId: detail.providerThreadId },
      }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(handle);
  }, [detail]);

  const onForward = useCallback((m: ThreadMessage) => {
    setForwardMessage(m);
    setForwardTick((n) => n + 1);
  }, []);
  const onShowOriginal = useCallback((m: ThreadMessage) => {
    setShowOriginal(m);
  }, []);

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
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-divider bg-surface px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("common.back")}
              className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-foreground md:hidden"
            >
              <ArrowLeft size={16} aria-hidden />
            </button>
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {detail?.subject ?? subject}
            </h2>
            <p className="mt-0.5 truncate text-xs text-tertiary">{headerCount}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {detail ? (
            <ThreadActions
              providerThreadId={detail.providerThreadId}
              onChanged={() => setLocalRefresh((n) => n + 1)}
            />
          ) : null}
        </div>
      </header>

      <div className="shrink-0 border-b border-divider bg-surface px-3 py-1.5 sm:px-4">
        <TagChips threadId={threadId} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4">
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
                  defaultExpanded={i === detail.messages.length - 1}
                  allowRemoteImages={allowRemoteImages}
                  onAllowImages={() => setAllowRemoteImages(true)}
                  onForward={() => onForward(m)}
                  onShowOriginal={() => onShowOriginal(m)}
                  onChanged={() => setLocalRefresh((n) => n + 1)}
                />
              </li>
            ))}
          </ol>
        )}

        {detail ? (
          <InlineReply
            thread={detail}
            autoExpandKey={replyTick}
            {...(forwardMessage ? { forwardMessage } : {})}
            forwardKey={forwardTick}
            onSent={() => {
              setForwardMessage(null);
              setLocalRefresh((n) => n + 1);
            }}
          />
        ) : null}
      </div>

      {showOriginal ? (
        <ShowOriginalModal
          message={showOriginal}
          onClose={() => setShowOriginal(null)}
        />
      ) : null}
    </div>
  );
}

interface MessageCardProps {
  message: ThreadMessage;
  defaultExpanded: boolean;
  allowRemoteImages: boolean;
  onAllowImages: () => void;
  onForward: () => void;
  onShowOriginal: () => void;
  onChanged: () => void;
}

function MessageCard({
  message,
  defaultExpanded,
  allowRemoteImages,
  onAllowImages,
  onForward,
  onShowOriginal,
  onChanged,
}: MessageCardProps) {
  const { t } = useTranslator();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showDetails, setShowDetails] = useState(false);
  const [starred, setStarred] = useState(message.starred);

  useEffect(() => {
    setStarred(message.starred);
  }, [message.starred]);

  const senderName = message.fromName ?? message.fromEmail ?? message.from;

  const toggleStar = useCallback(() => {
    const next = !starred;
    setStarred(next);
    void dispatchCommand({
      type: "mail:star",
      payload: { providerMessageId: message.providerMessageId, starred: next },
    })
      .then(() => onChanged())
      .catch(() => setStarred(!next));
  }, [message.providerMessageId, onChanged, starred]);

  return (
    <article
      className={
        "rounded-lg border border-divider bg-surface text-sm transition-colors " +
        (message.unread ? "ring-1 ring-accent/40" : "")
      }
    >
      <header
        className="flex items-start gap-3 px-3 py-3 sm:px-4"
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
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStar();
                }}
                title={starred ? t("inbox.unstar") : t("inbox.star")}
                aria-label={starred ? t("inbox.unstar") : t("inbox.star")}
                className={
                  "inline-flex h-6 w-6 items-center justify-center rounded text-tertiary hover:text-foreground " +
                  (starred ? "text-amber-500 hover:text-amber-600" : "")
                }
              >
                <Star
                  size={14}
                  aria-hidden
                  fill={starred ? "currentColor" : "none"}
                />
              </button>
              {message.hasAttachments ? (
                <Paperclip size={12} aria-hidden className="text-tertiary" />
              ) : null}
              <time
                dateTime={message.date}
                title={formatExact(message.date)}
                className="shrink-0 text-xs text-secondary"
              >
                {formatRelativeOrShort(message.date)}
              </time>
            </div>
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
        <div className="border-t border-divider px-3 py-3 sm:px-4 sm:py-4">
          <MessageBody
            message={message}
            allowRemoteImages={allowRemoteImages}
            onAllowImages={onAllowImages}
          />
          {message.attachments.length > 0 ? (
            <AttachmentsList attachments={message.attachments} />
          ) : null}
          <MessageFooterActions
            message={message}
            onForward={onForward}
            onShowOriginal={onShowOriginal}
          />
        </div>
      ) : null}
    </article>
  );
}

function AttachmentsList({ attachments }: { attachments: readonly ThreadAttachment[] }) {
  const visible = attachments.filter((a) => !a.isInline);
  if (visible.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-divider pt-3">
      {visible.map((a) => (
        <a
          key={a.id}
          href={`${baseUrl()}/api/attachments/${encodeURIComponent(a.id)}`}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex max-w-[18rem] items-center gap-2 rounded border border-divider bg-foreground/5 px-2 py-1 text-xs text-foreground hover:bg-foreground/10"
          title={a.filename}
        >
          <AttachmentIcon mime={a.mime} />
          <span className="truncate">{a.filename}</span>
          <span className="shrink-0 text-[10px] text-tertiary">
            {formatSize(a.sizeBytes)}
          </span>
          <Download size={12} aria-hidden className="shrink-0 text-tertiary" />
        </a>
      ))}
    </div>
  );
}

function AttachmentIcon({ mime }: { mime: string }) {
  if (mime.startsWith("image/"))
    return <FileImage size={14} aria-hidden className="shrink-0" />;
  if (mime.startsWith("text/") || mime === "application/pdf")
    return <FileText size={14} aria-hidden className="shrink-0" />;
  return <File size={14} aria-hidden className="shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FooterProps {
  message: ThreadMessage;
  onForward: () => void;
  onShowOriginal: () => void;
}

function MessageFooterActions({ message, onForward, onShowOriginal }: FooterProps) {
  const { t } = useTranslator();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-divider pt-2 text-xs text-secondary">
      <button
        type="button"
        onClick={onForward}
        className="inline-flex items-center gap-1 rounded border border-divider px-2 py-1 hover:bg-foreground/5 hover:text-foreground"
        title={t("thread.forward")}
      >
        {t("thread.forward")}
      </button>
      <a
        href={`${baseUrl()}/api/messages/${encodeURIComponent(message.id)}/raw.eml`}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 rounded border border-divider px-2 py-1 hover:bg-foreground/5 hover:text-foreground"
        title={t("thread.downloadEml")}
      >
        <Download size={12} aria-hidden />
        {t("thread.downloadEml")}
      </a>
      <button
        type="button"
        onClick={onShowOriginal}
        className="inline-flex items-center gap-1 rounded border border-divider px-2 py-1 hover:bg-foreground/5 hover:text-foreground"
        title={t("thread.showOriginal")}
      >
        <ScrollText size={12} aria-hidden />
        {t("thread.showOriginal")}
      </button>
    </div>
  );
}

interface MessageBodyProps {
  message: ThreadMessage;
  allowRemoteImages: boolean;
  onAllowImages: () => void;
}

function MessageBody({ message, allowRemoteImages, onAllowImages }: MessageBodyProps) {
  const { t } = useTranslator();
  if (message.bodyHtml && message.bodyHtml.trim().length > 0) {
    return (
      <HtmlBody
        html={message.bodyHtml}
        attachments={message.attachments}
        allowRemoteImages={allowRemoteImages}
        onAllowImages={onAllowImages}
      />
    );
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
interface HtmlBodyProps {
  html: string;
  attachments: readonly ThreadAttachment[];
  allowRemoteImages: boolean;
  onAllowImages: () => void;
}

function HtmlBody({ html, attachments, allowRemoteImages, onAllowImages }: HtmlBodyProps) {
  const { t } = useTranslator();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(120);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const cidMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attachments) {
      if (a.contentId) m.set(stripAngles(a.contentId), a.id);
    }
    return m;
  }, [attachments]);

  const { html: rewritten, blockedRemote } = useMemo(
    () =>
      mounted
        ? rewriteEmailHtml(html, cidMap, allowRemoteImages)
        : { html: "", blockedRemote: false },
    [html, mounted, cidMap, allowRemoteImages],
  );

  const safe = useMemo(() => (mounted ? sanitizeEmailHtml(rewritten) : ""), [
    rewritten,
    mounted,
  ]);
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
    <div className="space-y-2">
      {blockedRemote && !allowRemoteImages ? (
        <div className="flex items-center gap-2 rounded border border-divider bg-foreground/5 px-2 py-1 text-xs text-secondary">
          <ImageOff size={14} aria-hidden />
          <span className="flex-1">{t("thread.imagesBlocked")}</span>
          <button
            type="button"
            onClick={onAllowImages}
            className="rounded border border-divider px-2 py-0.5 text-xs font-medium text-foreground hover:bg-foreground/10"
          >
            {t("thread.displayImages")}
          </button>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title="message body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
        style={{ width: "100%", height, border: "0" }}
      />
    </div>
  );
}

function stripAngles(s: string): string {
  return s.replace(/^<|>$/g, "");
}

// Rewrite `cid:` references to /api/attachments/:id/inline so the
// iframe can load them directly from the API. Block all remote
// (http/https) images by default; the parent can opt in.
function rewriteEmailHtml(
  html: string,
  cidMap: Map<string, string>,
  allowRemoteImages: boolean,
): { html: string; blockedRemote: boolean } {
  if (typeof DOMParser === "undefined") {
    return { html, blockedRemote: false };
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  let blockedRemote = false;

  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("cid:")) {
      const cid = stripAngles(src.slice(4));
      const attId = cidMap.get(cid);
      if (attId) {
        img.setAttribute(
          "src",
          `${baseUrl()}/api/attachments/${encodeURIComponent(attId)}/inline`,
        );
      } else {
        img.removeAttribute("src");
        img.setAttribute("alt", img.getAttribute("alt") ?? "(missing inline image)");
      }
      return;
    }
    if (/^https?:/i.test(src)) {
      if (!allowRemoteImages) {
        blockedRemote = true;
        img.setAttribute("data-mailai-remote-src", src);
        img.removeAttribute("src");
      }
      return;
    }
    if (src.startsWith("data:")) return;
    if (src.startsWith("/")) return;
    img.removeAttribute("src");
  });

  return { html: doc.body.innerHTML, blockedRemote };
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

interface OriginalDoc {
  headers: Record<string, string>;
  raw: string;
}

function ShowOriginalModal({
  message,
  onClose,
}: {
  message: ThreadMessage;
  onClose: () => void;
}) {
  const { t } = useTranslator();
  const [data, setData] = useState<OriginalDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${baseUrl()}/api/messages/${encodeURIComponent(message.id)}/headers`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<OriginalDoc>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [message.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-divider bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-divider px-4 py-2">
          <h3 className="text-sm font-medium">{t("thread.showOriginal")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-secondary hover:bg-foreground/5 hover:text-foreground"
          >
            {t("common.close")}
          </button>
        </header>
        <div className="flex-1 overflow-auto px-4 py-3 text-xs">
          {error ? (
            <p className="text-error">{error}</p>
          ) : !data ? (
            <p className="text-secondary">{t("thread.loading")}</p>
          ) : (
            <>
              <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                {Object.entries(data.headers).map(([k, v]) => (
                  <FragmentRow key={k} k={k} v={v} />
                ))}
              </dl>
              <pre className="whitespace-pre-wrap break-words rounded border border-divider bg-foreground/5 p-3 font-mono text-[11px] leading-snug">
                {data.raw}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-tertiary">{k}</dt>
      <dd className="break-words font-mono">{v}</dd>
    </>
  );
}

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
// iframe (see app/lib/email-html.ts). The iframe itself sandboxes
// scripts / forms / top-navigation as defence-in-depth — it keeps
// `allow-same-origin` so we can measure the rendered height, but
// `allow-scripts` is intentionally absent which is what makes
// keeping <style> tags safe.

import {
  ArrowLeft,
  Download,
  File,
  FileImage,
  FileText,
  ImageOff,
  Paperclip,
  Star,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { apiFetch, baseUrl } from "../lib/api";
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
import {
  buildIframeDoc,
  rewriteEmailHtml,
  sanitizeEmailHtml,
  stripAngles,
} from "../lib/email-html";
import { readEmailIframeThemeSnapshot } from "../lib/email-iframe-theme";

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

  // The bottom InlineReply bar owns the Forward UI now (Reply / Reply
  // All / Forward). The default forward target is the latest message
  // in the thread — same convention as Gmail / Outlook desktop.
  const forwardMessage = detail?.messages[detail.messages.length - 1] ?? null;

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

      {/*
        Scroll container holds the messages only — the reply pane is
        a flex sibling below, NOT a sticky child of this scroller.
        Sticky-inside-scroll meant a translucent reply bar would let
        white email iframes peek through whenever the user scrolled,
        and a white card could occasionally render below the bar
        because the sticky stack order changed mid-scroll. Pulling
        the reply pane out of the scroller eliminates both: the
        scroller shrinks to fit the remaining height, the reply pane
        owns the bottom rail outright.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-background">
        {error ? (
          <p className="px-3 py-3 text-sm text-error sm:px-4 sm:py-4">
            {t("thread.loadError", { error })}
          </p>
        ) : detail === null ? (
          <p className="px-3 py-3 text-sm text-secondary sm:px-4 sm:py-4">{t("thread.loading")}</p>
        ) : (
          <ol className="flex flex-col">
            {detail.messages.map((m, i) => (
              <li
                key={m.id}
                className={
                  // Flat Gmail/Outlook-style row. We only draw a
                  // top-divider between messages (not around them) so
                  // the conversation reads as one continuous column
                  // rather than a stack of independent cards.
                  i === 0 ? "" : "border-t border-divider"
                }
              >
                <MessageCard
                  message={m}
                  defaultExpanded={i === detail.messages.length - 1}
                  allowRemoteImages={allowRemoteImages}
                  onAllowImages={() => setAllowRemoteImages(true)}
                  onChanged={() => setLocalRefresh((n) => n + 1)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      {detail ? (
        <div className="shrink-0 border-t border-divider bg-background">
          <InlineReply
            thread={detail}
            autoExpandKey={replyTick}
            {...(forwardMessage ? { forwardMessage } : {})}
            onSent={() => {
              setLocalRefresh((n) => n + 1);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

interface MessageCardProps {
  message: ThreadMessage;
  defaultExpanded: boolean;
  allowRemoteImages: boolean;
  onAllowImages: () => void;
  onChanged: () => void;
}

function MessageCard({
  message,
  defaultExpanded,
  allowRemoteImages,
  onAllowImages,
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
    // Flat row layout (Gmail/Outlook style). No outer border or
    // radius — the parent <li> draws a 1px top divider between
    // siblings so the whole conversation reads as one column.
    // Unread messages get a 2px accent rail on the left instead of
    // a ring, which is the same affordance Outlook uses.
    <article
      className={
        "text-sm transition-colors " +
        (message.unread
          ? "border-l-2 border-accent bg-background"
          : "border-l-2 border-transparent bg-background")
      }
    >
      <header
        className="flex items-start gap-3 px-3 py-3 sm:px-4 sm:py-3.5"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <Avatar name={senderName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span className={message.unread ? "font-semibold" : "font-medium"}>{senderName}</span>
              {message.fromEmail && message.fromName ? (
                <span className="ml-1.5 text-xs text-tertiary">&lt;{message.fromEmail}&gt;</span>
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
                <Star size={14} aria-hidden fill={starred ? "currentColor" : "none"} />
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
              {expanded ? (
                <a
                  href={`${baseUrl()}/api/messages/${encodeURIComponent(message.id)}/raw.eml`}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  title={t("thread.downloadEml")}
                  aria-label={t("thread.downloadEml")}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-tertiary hover:text-foreground"
                >
                  <Download size={14} aria-hidden />
                </a>
              ) : null}
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
        </div>
      ) : null}
    </article>
  );
}

function AttachmentsList({ attachments }: { attachments: readonly ThreadAttachment[] }) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const visible = attachments.filter((a) => !a.isInline);
  if (visible.length === 0) return null;
  const openInOffice = async (attachment: ThreadAttachment) => {
    setOpeningId(attachment.id);
    try {
      const from = mailaiShellReturnPath();
      const res = await apiFetch(
        `/api/attachments/${encodeURIComponent(attachment.id)}/office-url?from=${encodeURIComponent(from)}`,
      );
      if (!res.ok) {
        throw new Error(await responseErrorMessage(res));
      }
      const data = (await res.json()) as { url?: unknown };
      if (typeof data.url !== "string" || !data.url) throw new Error("Missing editor URL");
      navigateToOfficeEditor(data.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.alert(`Could not open attachment in OfficeAI: ${message}`);
    } finally {
      setOpeningId(null);
    }
  };
  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-divider pt-3">
      {visible.map((a) => {
        const officeEditable = isOfficeEditableAttachment(a);
        return (
          <span
            key={a.id}
            className="inline-flex max-w-[22rem] items-center gap-2 rounded border border-divider bg-foreground/5 px-2 py-1 text-xs text-foreground hover:bg-foreground/10"
            title={a.filename}
          >
            <AttachmentIcon mime={a.mime} />
            <span className="truncate">{a.filename}</span>
            <span className="shrink-0 text-[10px] text-tertiary">{formatSize(a.sizeBytes)}</span>
            {officeEditable ? (
              <button
                type="button"
                onClick={() => void openInOffice(a)}
                disabled={openingId === a.id}
                className="shrink-0 rounded px-1 text-[10px] text-tertiary hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                {openingId === a.id ? "Opening..." : "Open"}
              </button>
            ) : null}
            <a
              href={`${baseUrl()}/api/attachments/${encodeURIComponent(a.id)}/bytes`}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 rounded p-0.5 text-tertiary hover:bg-foreground/10 hover:text-foreground"
              title="Download"
            >
              <Download size={12} aria-hidden />
            </a>
          </span>
        );
      })}
    </div>
  );
}

function navigateToOfficeEditor(url: string): void {
  if (isFramed()) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) return;
  }
  window.location.assign(url);
}

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

const OFFICE_ATTACHMENT_EXTENSIONS = new Set(["docx", "xlsx", "pptx", "pdf"]);

function isOfficeEditableAttachment(attachment: ThreadAttachment): boolean {
  const ext = attachment.filename.split(".").pop()?.toLowerCase();
  return Boolean(ext && OFFICE_ATTACHMENT_EXTENSIONS.has(ext));
}

function mailaiShellReturnPath(): string {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return current.startsWith("/__subapps/mailai/")
    ? current
    : `/__subapps/mailai${current.startsWith("/") ? current : `/${current}`}`;
}

async function responseErrorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  if (!body) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Keep the plain response body below.
  }
  return body;
}

function AttachmentIcon({ mime }: { mime: string }) {
  if (mime.startsWith("image/")) return <FileImage size={14} aria-hidden className="shrink-0" />;
  if (mime.startsWith("text/") || mime === "application/pdf")
    return <FileText size={14} aria-hidden className="shrink-0" />;
  return <File size={14} aria-hidden className="shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    <p className="whitespace-pre-wrap text-foreground/90">
      {message.snippet || t("thread.noBody")}
    </p>
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

function attachIframeInlineImageActivation(
  iframe: HTMLIFrameElement,
  opts: {
    shouldOfferInlineImagePreview: (img: HTMLImageElement) => boolean;
    setInlineImagePreview: Dispatch<SetStateAction<{ src: string; alt: string } | null>>;
  },
): (() => void) | undefined {
  try {
    const innerDoc = iframe.contentDocument;
    if (!innerDoc) return undefined;

    const onActivateCapture = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const img = findImageFromIframeEventTarget(event.target);
      if (!img || !opts.shouldOfferInlineImagePreview(img)) return;
      const src = (img.currentSrc || img.src || "").trim();
      if (!src || src.startsWith("javascript:")) return;
      event.preventDefault();
      event.stopPropagation();
      opts.setInlineImagePreview({ src, alt: img.alt ?? "" });
    };

    innerDoc.addEventListener("click", onActivateCapture, true);
    return () => innerDoc.removeEventListener("click", onActivateCapture, true);
  } catch {
    return undefined;
  }
}

function findImageFromIframeEventTarget(target: EventTarget | null): HTMLImageElement | null {
  if (!target || typeof target !== "object") return null;

  // Iframe nodes live in a different JS realm, so parent-window
  // `instanceof HTMLImageElement/Element` checks are unreliable.
  const candidate = target as {
    tagName?: unknown;
    closest?: unknown;
  };
  if (typeof candidate.tagName === "string" && candidate.tagName.toLowerCase() === "img") {
    return candidate as HTMLImageElement;
  }
  if (typeof candidate.closest === "function") {
    const closest = candidate.closest.call(candidate, "img");
    return closest && typeof closest === "object" ? (closest as HTMLImageElement) : null;
  }
  return null;
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
  const { resolvedTheme } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Start at 0 so empty/short messages don't reserve a fat blank
  // band before the first measurement lands. We bump to the real
  // height as soon as the iframe DOM is reachable.
  const [height, setHeight] = useState<number>(0);
  const [mounted, setMounted] = useState(false);
  const [inlineImagePreview, setInlineImagePreview] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!inlineImagePreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInlineImagePreview(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inlineImagePreview]);

  /** Skip obvious tracking pixels — parent registers clicks on iframe DOM (no iframe scripts). */
  const shouldOfferInlineImagePreview = useCallback((img: HTMLImageElement) => {
    const src = (img.currentSrc || img.getAttribute("src") || "").trim();
    if (!src || src.startsWith("javascript:")) return false;
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      if (img.naturalWidth <= 32 && img.naturalHeight <= 32) return false;
    }
    return true;
  }, []);

  const cidMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attachments) {
      if (a.contentId) {
        const stripped = stripAngles(a.contentId);
        m.set(stripped, a.id);
        const lower = stripped.toLowerCase();
        if (lower !== stripped) m.set(lower, a.id);
      }
    }
    return m;
  }, [attachments]);

  const filenameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attachments) {
      const raw = a.filename?.trim();
      if (!raw) continue;
      const base = raw.split(/[/\\]/).pop() ?? raw;
      let key: string;
      try {
        key = decodeURIComponent(base).trim().toLowerCase();
      } catch {
        key = base.trim().toLowerCase();
      }
      if (!key) continue;
      if (!m.has(key)) m.set(key, a.id);
    }
    return m;
  }, [attachments]);

  const inlineUrl = useCallback(
    (attId: string) => `${baseUrl()}/api/attachments/${encodeURIComponent(attId)}/inline`,
    [],
  );

  const { html: rewritten, blockedRemote } = useMemo(
    () =>
      mounted
        ? rewriteEmailHtml({
            html,
            cidToAttachmentId: cidMap,
            filenameToAttachmentId: filenameMap,
            allowRemoteImages,
            attachmentInlineUrl: inlineUrl,
          })
        : { html: "", blockedRemote: false },
    [html, mounted, cidMap, filenameMap, allowRemoteImages, inlineUrl],
  );

  const safe = useMemo(() => (mounted ? sanitizeEmailHtml(rewritten) : ""), [rewritten, mounted]);
  const darkReader = mounted && resolvedTheme === "dark";

  const themeSnapshot = useMemo(() => {
    if (!mounted || typeof document === "undefined") {
      return readEmailIframeThemeSnapshot(null);
    }
    return readEmailIframeThemeSnapshot(document.documentElement);
  }, [mounted, resolvedTheme]);

  const doc = useMemo(
    () => buildIframeDoc(safe, { darkMode: darkReader, theme: themeSnapshot }),
    [safe, darkReader, themeSnapshot],
  );

  useEffect(() => {
    const el = iframeRef.current;
    if (!el || !mounted) return;

    let cancelled = false;

    /** Parent-side listener on iframe document (no iframe allow-scripts). */
    let detachInlineImageActivation: (() => void) | undefined;

    const tryAttachInlineImageActivation = () => {
      detachInlineImageActivation?.();
      detachInlineImageActivation = attachIframeInlineImageActivation(el, {
        shouldOfferInlineImagePreview,
        setInlineImagePreview,
      });
    };

    const measure = () => {
      if (cancelled) return;
      try {
        const inner = el.contentDocument;
        const root = inner?.documentElement;
        const body = inner?.body;
        if (!inner || !root || !body) return;
        // scrollHeight often overshoots in filtered/sandbox docs, leaving a
        // tall iframe with empty UA buffer rows (reads as bright bands
        // above siblings). Prefer the inverted reader subtree when present.
        const reader = body.querySelector(".mailai-dark-reader");
        const h =
          reader instanceof HTMLElement
            ? Math.ceil(reader.offsetTop + reader.offsetHeight)
            : Math.max(root.scrollHeight, body.scrollHeight);
        if (h > 0) setHeight(Math.min(h + 1, 8000));
      } catch {
        // Without `allow-same-origin` we'd land here. With it the
        // catch is dead code; keep it so a future tightening of the
        // sandbox doesn't crash the reader.
      }
    };

    const onLoad = () => {
      if (cancelled) return;
      measure();
      tryAttachInlineImageActivation();
      try {
        const inner = el.contentDocument;
        if (!inner) return;
        for (const img of Array.from(inner.images)) {
          if (img.complete) continue;
          img.addEventListener("load", measure, { once: true });
          img.addEventListener("error", measure, { once: true });
        }
        if (typeof ResizeObserver !== "undefined" && inner.body) {
          const ro = new ResizeObserver(() => measure());
          ro.observe(inner.body);
          el.addEventListener("unload", () => ro.disconnect(), { once: true });
        }
      } catch {
        // Same as above — ignored under stricter sandbox.
      }
    };

    el.addEventListener("load", onLoad);

    // Do NOT tie attachment to iframe.contentDocument.readyState here: when
    // srcDoc swaps, React's commit can still briefly expose the previous
    // complete document — listeners end up on a detached Document.
    const tAttach0 = setTimeout(() => {
      if (!cancelled) tryAttachInlineImageActivation();
    }, 0);
    const tAttach120 = setTimeout(() => {
      if (!cancelled) tryAttachInlineImageActivation();
    }, 120);

    const t1 = setTimeout(measure, 250);
    const t2 = setTimeout(measure, 1500);
    return () => {
      cancelled = true;
      detachInlineImageActivation?.();
      el.removeEventListener("load", onLoad);
      clearTimeout(tAttach0);
      clearTimeout(tAttach120);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [doc, mounted, shouldOfferInlineImagePreview]);

  return (
    <>
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
          className="block w-full rounded-none border-0 bg-transparent shadow-none outline-none ring-0 focus:outline-none"
          // `allow-same-origin` is required so we can read scrollHeight
          // and observe image load events from the parent. We DO NOT
          // grant `allow-scripts`, which is what keeps inline <style>
          // and `style` attributes safe even though the iframe shares
          // an origin with us.
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          srcDoc={doc}
          // min-height keeps single-line "(empty)" messages from
          // collapsing to nothing while the first measurement lands.
          // Transparent iframe + embedded doc uses transparent chrome so
          // the thread pane shows through — avoids browser color-scheme
          // rims and mismatched solids around inverted HTML bodies.
          style={{
            width: "100%",
            height: height || undefined,
            minHeight: height ? undefined : 32,
            borderWidth: 0,
            outline: "none",
            display: "block",
            background: "transparent",
          }}
        />
      </div>
      {mounted && inlineImagePreview
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={t("thread.imagePreview")}
              className="fixed inset-0 z-[200] flex items-center justify-center bg-foreground/75 p-4"
              onClick={() => setInlineImagePreview(null)}
            >
              <button
                type="button"
                className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-md border border-divider bg-background text-foreground shadow-lg hover:bg-hover"
                aria-label={t("thread.closeImagePreview")}
                onClick={(e) => {
                  e.stopPropagation();
                  setInlineImagePreview(null);
                }}
              >
                <X size={18} aria-hidden />
              </button>
              <img
                src={inlineImagePreview.src}
                alt={inlineImagePreview.alt || t("thread.imagePreview")}
                className="max-h-[92dvh] max-w-[min(96vw,1200px)] object-contain"
                onClick={(e) => e.stopPropagation()}
                draggable={false}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
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

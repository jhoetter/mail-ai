// In-thread reply pane. Anchored to the bottom of ThreadView the same
// way Gmail / Front does — never a modal, because replying to mail is
// not a side trip away from the conversation, it IS the conversation.
//
// Visual states:
//   1. Collapsed → a "Reply / Reply all / Forward" bar. The default
//      so the conversation reads cleanly until the user actually
//      decides to write something.
//   2. Expanded  → mode-specific recipient row(s) + editor +
//      Send/Discard. The mode (reply, reply-all, forward) is chosen
//      by the user via the collapsed bar OR by a parent shortcut.
//
// Recipient editing in v2:
//   - Reply         → To prefilled with the source's From; Cc/Bcc
//                     hidden behind a toggle.
//   - Reply all     → To prefilled with the source's From and any
//                     parsed To; Cc starts hidden but visible by
//                     default if the source had visible Cc-style
//                     extras (we currently only have the message's
//                     `to` string at our disposal so we expose them
//                     all in To and let the user move them).
//   - Forward       → To empty; user fills it in.
//
// All three flows now ship custom recipient lists down to the
// server. `mail:reply` accepts optional `to`/`cc`/`bcc` overrides;
// `mail:forward` already required them.

import { Button, RichEditor, type RichEditorChange, type RichEditorHandle } from "@mailai/ui";
import { Forward, Reply, ReplyAll, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../lib/api";
import { useTranslator } from "../lib/i18n/useTranslator";
import type { ThreadDetail, ThreadMessage } from "../lib/threads-client";
import { useAttachmentUploads } from "../lib/attachment-uploads";
import { useMyEmails } from "../lib/use-my-emails";
import { AttachmentTray } from "./AttachmentTray";
import { RecipientField } from "./RecipientField";

type ComposeMode = "reply" | "reply-all" | "forward";

interface Props {
  readonly thread: ThreadDetail;
  readonly onSent: () => void;
  /**
   * Auto-expand on mount. Used by the keyboard shortcut "r" so the
   * editor is ready as soon as the user hits the key. Defaults to
   * "reply" mode.
   */
  readonly autoExpand?: boolean;
  readonly autoExpandKey?: number;
  /**
   * Default source for "forward" mode: the message whose body gets
   * quoted into the editor and whose providerMessageId is attached as
   * message/rfc822 when the user sends. ThreadView passes the latest
   * message in the thread; the user picks Forward from the bottom
   * bar (or via the palette) to engage the flow.
   */
  readonly forwardMessage?: ThreadMessage;
}

export function InlineReply({ thread, onSent, autoExpand, autoExpandKey, forwardMessage }: Props) {
  const { t } = useTranslator();
  const [mode, setMode] = useState<ComposeMode | null>(autoExpand ? "reply" : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valueRef = useRef<RichEditorChange>({ html: "", text: "" });
  const editorRef = useRef<RichEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useAttachmentUploads({ draftId: null });

  const root = thread.messages[thread.messages.length - 1];
  const replyToName = root?.fromName ?? root?.fromEmail ?? root?.from ?? "";
  // Lowercase set of every connected mailbox the user owns. We use it
  // to keep the user out of their own Reply All — nothing more
  // awkward than CC'ing yourself on a thread you just hit reply on.
  const myEmails = useMyEmails();

  // Default recipient lists for each mode, derived from the most
  // recent message.
  //   - Reply       → To = source sender. The user can edit before
  //                   sending; Cc/Bcc start hidden.
  //   - Reply All   → To = source sender + everyone else who was on
  //                   To, MINUS the user's own connected addresses
  //                   (we don't reply to ourselves). Cc = whatever
  //                   was Cc on the source, also minus self. Bcc
  //                   stays empty — Bcc on a *received* message is
  //                   almost always null and even when present we
  //                   shouldn't re-publish it to other recipients.
  //   - Forward     → blank, user supplies recipients.
  // We don't strip "me" from a plain Reply: in Reply mode the only
  // address in To is the original sender, and if that sender IS the
  // user (a self-sent message they're following up on) leaving the
  // chip in place is the right default — providers will deliver.
  const defaults = useMemo(() => {
    const sender = root?.fromEmail?.trim() ?? "";
    const toOthers = parseAddressList(root?.to ?? "");
    const ccOthers = parseAddressList(root?.cc ?? "");
    const isMe = (addr: string) => myEmails.has(addr.toLowerCase());
    const replyAllTo = dedupe([sender, ...toOthers].filter((s) => s.length > 0 && !isMe(s)));
    return {
      reply: { to: sender ? [sender] : [], cc: [] as string[], bcc: [] as string[] },
      "reply-all": {
        to: replyAllTo,
        cc: dedupe(ccOthers.filter((s) => !isMe(s))),
        bcc: [] as string[],
      },
      forward: { to: [] as string[], cc: [] as string[], bcc: [] as string[] },
    } as const;
  }, [root, myEmails]);

  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);

  // When the user picks a mode (or the parent triggers one via a
  // shortcut), rehydrate the recipient chips from the defaults for
  // that mode. We only do this on mode TRANSITIONS — not on every
  // render — so the user's edits during composition aren't clobbered.
  const syncRecipients = useCallback(
    (next: ComposeMode) => {
      const d = defaults[next];
      setTo([...d.to]);
      setCc([...d.cc]);
      setBcc([...d.bcc]);
      setShowCc(d.cc.length > 0);
      setShowBcc(d.bcc.length > 0);
    },
    [defaults],
  );

  const expand = useCallback(
    (next: ComposeMode) => {
      setMode(next);
      syncRecipients(next);
      // Forward inserts the quoted source body into a fresh editor so
      // the user can write their note above it. Reply / Reply All
      // start with a blank editor — the quoted history ships separately
      // via the server-side reply assembly path.
      if (next === "forward" && forwardMessage) {
        const quoted = quoteForward(forwardMessage);
        queueMicrotask(() => {
          editorRef.current?.setContent(quoted.html);
          valueRef.current = quoted;
          editorRef.current?.focus();
        });
        return;
      }
      queueMicrotask(() => editorRef.current?.focus());
    },
    [syncRecipients, forwardMessage],
  );

  // Expand on demand from a parent shortcut (palette "r" / "f").
  // The key bumps every time so re-pressing focuses the editor
  // again. Critical: we must NOT fire on first mount — both ticks
  // start at 0, which is a real number (not undefined), so a naive
  // dependency array would auto-expand the pane every time the
  // user opens a thread. We track the previous key value in a ref
  // and only act on increments.
  const prevAutoKeyRef = useRef<number | undefined>(autoExpandKey);
  useEffect(() => {
    if (autoExpandKey === undefined) return;
    if (prevAutoKeyRef.current === autoExpandKey) {
      prevAutoKeyRef.current = autoExpandKey;
      return;
    }
    prevAutoKeyRef.current = autoExpandKey;
    expand("reply");
  }, [autoExpandKey, expand]);

  const onChange = useCallback((v: RichEditorChange) => {
    valueRef.current = v;
  }, []);

  const reset = useCallback(() => {
    editorRef.current?.setContent("");
    valueRef.current = { html: "", text: "" };
    setMode(null);
    setTo([]);
    setCc([]);
    setBcc([]);
    setShowCc(false);
    setShowBcc(false);
    setErr(null);
    uploads.reset();
  }, [uploads]);

  const send = useCallback(async () => {
    if (!mode) return;
    const { html, text } = valueRef.current;
    if (text.trim().length === 0) return;
    if (to.length === 0) {
      setErr(t("composer.toRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const idempotencyKey = `web:${mode === "forward" ? "fwd" : "reply"}:${thread.id}:${hash(text)}:${Date.now()
        .toString(36)
        .slice(0, 6)}`;
      const attachmentRefs = uploads.refs;
      if (mode === "forward") {
        if (!forwardMessage) {
          throw new Error("forward source missing");
        }
        await client().applyCommand({
          type: "mail:forward",
          payload: {
            providerMessageId: forwardMessage.providerMessageId,
            to,
            ...(cc.length > 0 ? { cc } : {}),
            ...(bcc.length > 0 ? { bcc } : {}),
            subject: prefixFwd(forwardMessage.subject ?? thread.subject ?? ""),
            body: text,
            ...(html.trim().length > 0 ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
            includeOriginalAsEml: true,
          },
          idempotencyKey,
        });
      } else {
        // Reply / Reply All collapse to the same backend command —
        // the difference is purely in which recipients the UI
        // pre-fills. The server honours whatever lists we ship.
        await client().applyCommand({
          type: "mail:reply",
          payload: {
            threadId: thread.id,
            body: text,
            ...(html.trim().length > 0 ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
            to,
            ...(cc.length > 0 ? { cc } : {}),
            ...(bcc.length > 0 ? { bcc } : {}),
          },
          idempotencyKey,
        });
      }
      reset();
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [bcc, cc, forwardMessage, mode, onSent, reset, t, thread.id, thread.subject, to, uploads]);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) void uploads.addFiles(files);
      e.target.value = "";
    },
    [uploads],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploads.addFiles(files);
    },
    [uploads],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) void uploads.addFiles(files);
    },
    [uploads],
  );

  if (mode === null) {
    return (
      // Lives outside the message scroll container (see ThreadView)
      // so it's a normal block element, not sticky — that removes
      // the previous shimmer-through-sticky-overlay class of bugs.
      <div className="bg-background px-3 py-3 sm:px-4">
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => expand("reply")}>
            <span className="inline-flex items-center gap-1.5">
              <Reply size={14} aria-hidden />
              {t("thread.reply")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => expand("reply-all")}>
            <span className="inline-flex items-center gap-1.5">
              <ReplyAll size={14} aria-hidden />
              {t("thread.replyAll")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => expand("forward")}>
            <span className="inline-flex items-center gap-1.5">
              <Forward size={14} aria-hidden />
              {t("thread.forward")}
            </span>
          </Button>
        </div>
      </div>
    );
  }

  const headerLabel =
    mode === "forward"
      ? t("thread.forwardingFrom", {
          name: forwardMessage?.fromName ?? forwardMessage?.fromEmail ?? forwardMessage?.from ?? "",
        })
      : mode === "reply-all"
        ? t("thread.replyingAll")
        : t("thread.replyingTo", { name: replyToName });

  return (
    <div
      // Lives outside the message scroll container (see ThreadView)
      // so it stays put without sticky/transparency tricks.
      className="bg-background px-3 pt-3 pb-3 sm:px-4 sm:pb-4"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      <div className="relative overflow-hidden rounded-md border border-divider bg-surface">
        {dragOver ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-foreground/40 bg-background/80 text-sm text-foreground"
            aria-hidden
          >
            {t("composer.dropFilesHere")}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
          <div className="min-w-0 truncate text-xs text-secondary">{headerLabel}</div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-tertiary">
            <kbd className="rounded border border-divider bg-background px-1.5 py-0.5 font-mono text-[10px] text-secondary">
              {t("thread.replyHint")}
            </kbd>
          </div>
        </div>

        <RecipientRow label={t("composer.to")}>
          <RecipientField
            value={to}
            onChange={setTo}
            placeholder={t("composer.to")}
            ariaLabel={t("composer.to")}
          />
          {(!showCc || !showBcc) && (
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-tertiary">
              {!showCc ? (
                <button
                  type="button"
                  className="hover:text-secondary"
                  onClick={() => setShowCc(true)}
                >
                  {t("composer.cc")}
                </button>
              ) : null}
              {!showBcc ? (
                <button
                  type="button"
                  className="hover:text-secondary"
                  onClick={() => setShowBcc(true)}
                >
                  {t("composer.bcc")}
                </button>
              ) : null}
            </div>
          )}
        </RecipientRow>
        {showCc ? (
          <RecipientRow label={t("composer.cc")}>
            <RecipientField
              value={cc}
              onChange={setCc}
              placeholder={t("composer.cc")}
              ariaLabel={t("composer.cc")}
            />
          </RecipientRow>
        ) : null}
        {showBcc ? (
          <RecipientRow label={t("composer.bcc")}>
            <RecipientField
              value={bcc}
              onChange={setBcc}
              placeholder={t("composer.bcc")}
              ariaLabel={t("composer.bcc")}
            />
          </RecipientRow>
        ) : null}

        <RichEditor
          ref={editorRef}
          ariaLabel={t("composer.body")}
          placeholder={
            mode === "forward"
              ? t("thread.forwardPlaceholder")
              : t("thread.replyPlaceholder", { name: replyToName })
          }
          minHeight={160}
          maxHeight={340}
          onChange={onChange}
          onSubmit={() => void send()}
        />
        <AttachmentTray slots={uploads.slots} onRemove={uploads.remove} onPick={onPickFiles} />
        {err ? (
          <p className="border-t border-divider bg-error-bg/40 px-3 py-2 text-xs text-error-text">
            {t("composer.sendError", { error: err })}
          </p>
        ) : null}
        <div className="flex items-center justify-between border-t border-divider px-3 py-2">
          <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
            <span className="inline-flex items-center gap-1.5">
              <Trash2 size={14} aria-hidden />
              {t("thread.discard")}
            </span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => void send()} disabled={busy}>
            <span className="inline-flex items-center gap-1.5">
              <Send size={14} aria-hidden />
              {busy ? t("composer.sending") : t("composer.send")}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

interface RecipientRowProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function RecipientRow({ label, children }: RecipientRowProps) {
  return (
    <div className="flex items-start gap-2 border-b border-divider px-3 py-1.5">
      <span className="mt-1.5 w-12 shrink-0 text-xs uppercase tracking-wide text-tertiary">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-start gap-2">{children}</div>
    </div>
  );
}

// Borrow the same hash from Composer so idempotency keys collide for
// double-submits but not for distinct messages.
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function prefixFwd(subject: string): string {
  if (/^fwd?:\s/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}

// Pull bare email addresses out of a comma/semicolon-separated header
// string. Tolerant of "Display Name <user@example.com>" and bare
// "user@example.com" forms — anything else we just drop, because
// the recipient field is going to validate addresses on send anyway.
function parseAddressList(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const angle = trimmed.match(/<([^>]+)>/);
    const candidate = angle?.[1] ?? trimmed;
    if (candidate.includes("@")) out.push(candidate.trim());
  }
  return out;
}

function dedupe(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function quoteForward(msg: ThreadMessage): RichEditorChange {
  const fromLine = msg.fromName
    ? `${msg.fromName} <${msg.fromEmail ?? ""}>`
    : (msg.fromEmail ?? msg.from ?? "");
  const dateLine = msg.date ? new Date(msg.date).toLocaleString() : "";
  const subjectLine = msg.subject ?? "";
  const headerHtml = [
    `<br><br>`,
    `<div data-mailai-forward style="margin-top:1em;padding-top:1em;border-top:1px solid #ccc;color:#555">`,
    `<div><b>---------- Forwarded message ----------</b></div>`,
    fromLine ? `<div>From: ${escapeHtml(fromLine)}</div>` : "",
    dateLine ? `<div>Date: ${escapeHtml(dateLine)}</div>` : "",
    subjectLine ? `<div>Subject: ${escapeHtml(subjectLine)}</div>` : "",
    `</div>`,
  ].join("");
  const bodyHtml = msg.bodyHtml ?? (msg.bodyText ? `<pre>${escapeHtml(msg.bodyText)}</pre>` : "");
  const html = `${headerHtml}<div>${bodyHtml}</div>`;
  const text = [
    "",
    "",
    "---------- Forwarded message ----------",
    fromLine ? `From: ${fromLine}` : "",
    dateLine ? `Date: ${dateLine}` : "",
    subjectLine ? `Subject: ${subjectLine}` : "",
    "",
    msg.bodyText ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return { html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Re-export so future thread-related callers can also key shortcut
// hookups by the latest message in the chain (Reply-all targets etc).
export type { ThreadMessage };

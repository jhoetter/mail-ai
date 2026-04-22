// In-thread reply pane. Anchored to the bottom of ThreadView the same
// way Gmail / Front does — never a modal, because replying to mail is
// not a side trip away from the conversation, it IS the conversation.
//
// Two visual states:
//   1. Collapsed → a single-row "Reply / Reply all / Forward" bar.
//      Cheap, doesn't fight the reading layout.
//   2. Expanded  → recipient row + subject/quote header + RichEditor +
//      Send/Discard. Stays inside the reader scroll context.
//
// We dispatch `mail:reply` (with bodyText + bodyHtml so the recipient
// gets a multipart message) and let the parent re-fetch the thread on
// success so the user sees their reply land.

import { Button, RichEditor, type RichEditorChange, type RichEditorHandle } from "@mailai/ui";
import { Forward, Reply, ReplyAll, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../lib/api";
import { useTranslator } from "../lib/i18n/useTranslator";
import type { ThreadDetail, ThreadMessage } from "../lib/threads-client";
import { useAttachmentUploads } from "../lib/attachment-uploads";
import { AttachmentTray } from "./AttachmentTray";
import { RecipientField } from "./RecipientField";

interface Props {
  readonly thread: ThreadDetail;
  readonly onSent: () => void;
  /**
   * Auto-expand on mount. Used by the keyboard shortcut "r" so the
   * editor is ready as soon as the user hits the key.
   */
  readonly autoExpand?: boolean;
  readonly autoExpandKey?: number;
  /**
   * If set, render in "forward" mode: shows a forward header, prefills
   * the editor with the quoted source body, and dispatches mail:forward
   * with the source providerMessageId attached as message/rfc822.
   */
  readonly forwardMessage?: ThreadMessage;
  readonly forwardKey?: number;
}

export function InlineReply({
  thread,
  onSent,
  autoExpand,
  autoExpandKey,
  forwardMessage,
  forwardKey,
}: Props) {
  const { t } = useTranslator();
  const [expanded, setExpanded] = useState(!!autoExpand || !!forwardMessage);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forwardTo, setForwardTo] = useState<string[]>([]);
  const valueRef = useRef<RichEditorChange>({ html: "", text: "" });
  const editorRef = useRef<RichEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useAttachmentUploads({ draftId: null });
  const isForward = !!forwardMessage;

  // Expand on demand from a parent shortcut (palette "r"). The key
  // bumps every time so re-pressing focuses the editor again.
  useEffect(() => {
    if (autoExpandKey === undefined) return;
    setExpanded(true);
    queueMicrotask(() => editorRef.current?.focus());
  }, [autoExpandKey]);

  useEffect(() => {
    if (forwardKey === undefined) return;
    setExpanded(true);
    if (forwardMessage) {
      const quoted = quoteForward(forwardMessage);
      editorRef.current?.setContent(quoted.html);
      valueRef.current = quoted;
    }
    queueMicrotask(() => editorRef.current?.focus());
  }, [forwardKey, forwardMessage]);

  const root = thread.messages[thread.messages.length - 1];
  const replyToName = root?.fromName ?? root?.fromEmail ?? root?.from ?? "";

  const onChange = useCallback((v: RichEditorChange) => {
    valueRef.current = v;
  }, []);

  const send = useCallback(async () => {
    const { html, text } = valueRef.current;
    if (text.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const idempotencyKey = `web:${isForward ? "fwd" : "reply"}:${thread.id}:${hash(text)}:${Date.now()
        .toString(36)
        .slice(0, 6)}`;
      const attachmentRefs = uploads.refs;
      if (isForward && forwardMessage) {
        const recipients = forwardTo;
        if (recipients.length === 0) {
          throw new Error(t("composer.toRequired"));
        }
        await client().applyCommand({
          type: "mail:forward",
          payload: {
            providerMessageId: forwardMessage.providerMessageId,
            to: recipients,
            subject: prefixFwd(forwardMessage.subject ?? thread.subject ?? ""),
            body: text,
            ...(html.trim().length > 0 ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
            includeOriginalAsEml: true,
          },
          idempotencyKey,
        });
      } else {
        await client().applyCommand({
          type: "mail:reply",
          payload: {
            threadId: thread.id,
            body: text,
            ...(html.trim().length > 0 ? { bodyHtml: html } : {}),
            ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
          },
          idempotencyKey,
        });
      }
      editorRef.current?.setContent("");
      valueRef.current = { html: "", text: "" };
      setExpanded(false);
      uploads.reset();
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [forwardMessage, forwardTo, isForward, onSent, t, thread.id, thread.subject, uploads]);

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

  if (!expanded) {
    return (
      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-divider bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Reply size={14} aria-hidden />
              {t("thread.reply")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <ReplyAll size={14} aria-hidden />
              {t("thread.replyAll")}
            </span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Forward size={14} aria-hidden />
              {t("thread.forward")}
            </span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-divider bg-background/95 px-4 pt-3 pb-4 backdrop-blur supports-[backdrop-filter]:bg-background/80"
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
      <div className="relative overflow-hidden rounded-lg border border-divider bg-surface shadow-sm">
        {dragOver ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-foreground/40 bg-background/80 text-sm text-foreground"
            aria-hidden
          >
            {t("composer.dropFilesHere")}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
          <div className="min-w-0 truncate text-xs text-secondary">
            {isForward
              ? t("thread.forwardingFrom", {
                  name:
                    forwardMessage?.fromName ??
                    forwardMessage?.fromEmail ??
                    forwardMessage?.from ??
                    "",
                })
              : t("thread.replyPlaceholder", { name: replyToName }).replace("…", "")}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-tertiary">
            <kbd className="rounded border border-divider bg-background px-1.5 py-0.5 font-mono text-[10px] text-secondary">
              {t("thread.replyHint")}
            </kbd>
          </div>
        </div>
        {isForward ? (
          <div className="flex items-center gap-2 border-b border-divider px-3 py-1.5">
            <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-tertiary">
              {t("composer.to")}
            </span>
            <RecipientField
              value={forwardTo}
              onChange={setForwardTo}
              placeholder={t("composer.to")}
              ariaLabel={t("composer.to")}
            />
          </div>
        ) : null}
        <RichEditor
          ref={editorRef}
          ariaLabel={t("composer.body")}
          placeholder={
            isForward
              ? t("thread.forwardPlaceholder")
              : t("thread.replyPlaceholder", { name: replyToName })
          }
          minHeight={160}
          maxHeight={340}
          onChange={onChange}
          onSubmit={() => void send()}
        />
        <AttachmentTray
          slots={uploads.slots}
          onRemove={uploads.remove}
          onPick={onPickFiles}
        />
        {err ? (
          <p className="border-t border-divider bg-error-bg/40 px-3 py-2 text-xs text-error-text">
            {t("composer.sendError", { error: err })}
          </p>
        ) : null}
        <div className="flex items-center justify-between border-t border-divider px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              editorRef.current?.setContent("");
              valueRef.current = { html: "", text: "" };
              setExpanded(false);
              setErr(null);
            }}
            disabled={busy}
          >
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

function quoteForward(msg: ThreadMessage): RichEditorChange {
  const fromLine = msg.fromName
    ? `${msg.fromName} <${msg.fromEmail ?? ""}>`
    : msg.fromEmail ?? msg.from ?? "";
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
  const bodyHtml =
    msg.bodyHtml ?? (msg.bodyText ? `<pre>${escapeHtml(msg.bodyText)}</pre>` : "");
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
